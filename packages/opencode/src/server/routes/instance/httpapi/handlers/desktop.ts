import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { InstanceHttpApi } from "../api"
import { DesktopActionInvokePayload } from "../groups/desktop"

type TtsConfig = {
  enabled?: boolean
  mode?: "full" | "summary"
  debug?: boolean
  backend?: "edge_tts" | "say"
  voice?: string
  edge_tts?: { player?: string; voice?: string; rate?: string; volume?: string }
}

const OPENCODE_DIR = path.join(os.homedir(), ".config", "opencode")
const TTS_CONFIG = path.join(OPENCODE_DIR, "plugins", "opencode-tts.jsonc")
const TTS_LOG = path.join(OPENCODE_DIR, "plugins", "opencode-tts.log")
const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
const EDGE_TTS_FORMAT = "riff-24khz-16bit-mono-pcm"
const WINDOWS_SOUND_PLAYER = "__windows_sound_player__"
const MACOS_SOUND_PLAYER = "__macos_sound_player__"
const LINUX_SOUND_PLAYER = "__linux_sound_player__"
let playback: ChildProcess | undefined
let playbackState: "idle" | "playing" | "paused" = "idle"
let playbackMessageID: string | undefined
let playbackAudioPath: string | undefined
let playbackPlayer: string | undefined
let playbackOffsetMs = 0
let playbackStartedAt = 0
let playbackBoundaryMs: number[] = []

function stripJsonComments(value: string) {
  return value.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function readTtsConfig(): TtsConfig {
  try {
    return JSON.parse(stripJsonComments(readFileSync(TTS_CONFIG, "utf8"))) as TtsConfig
  } catch {
    return {}
  }
}

function writeTtsConfig(config: TtsConfig) {
  mkdirSync(path.dirname(TTS_CONFIG), { recursive: true })
  writeFileSync(TTS_CONFIG, JSON.stringify(config, null, 2), "utf8")
}

function debugLog(config: TtsConfig, message: string, data?: unknown) {
  if (!config.debug) return
  try {
    mkdirSync(path.dirname(TTS_LOG), { recursive: true })
    appendFileSync(TTS_LOG, `[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`)
  } catch {}
}

function stopPlayback() {
  const audioPath = playbackAudioPath
  try {
    playback?.kill()
  } catch {}
  playback = undefined
  playbackState = "idle"
  playbackMessageID = undefined
  playbackAudioPath = undefined
  playbackPlayer = undefined
  playbackOffsetMs = 0
  playbackStartedAt = 0
  playbackBoundaryMs = []
  if (audioPath) {
    try {
      unlinkSync(audioPath)
    } catch {}
  }
}

function togglePlaybackPause() {
  if (playbackState === "playing" && playback) {
    playbackOffsetMs = nextBoundaryMs(playbackOffsetMs + Date.now() - playbackStartedAt)
    const child = playback
    playback = undefined
    playbackState = "paused"
    try {
      child.kill()
    } catch {}
    return true
  }
  if (playbackState === "paused" && playbackAudioPath) {
    startPlayback(playbackPlayer, playbackAudioPath, playbackOffsetMs)
    return true
  }
  return false
}

function parseTimestampMs(value: string) {
  const match = value.match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/)
  if (!match) return
  return Number(match[1] ?? 0) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4])
}

function readSubtitleBoundaries(file: string) {
  try {
    return Array.from(readFileSync(file, "utf8").matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->/g))
      .map((match) => parseTimestampMs(match[1]))
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

function nextBoundaryMs(offsetMs: number) {
  const boundary = playbackBoundaryMs.find((item) => item > offsetMs + 40)
  return boundary ?? offsetMs
}

function run(command: string, args: string[], isPlayback = false, env?: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : undefined })
    if (isPlayback) playback = child
    let stderr = ""
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", reject)
    child.on("close", (code) => {
      if (isPlayback && playback === child) {
        playback = undefined
        playbackState = "idle"
        playbackMessageID = undefined
      }
      code === 0 ? resolve() : reject(new Error(stderr || `${command} exited with ${code}`))
    })
  })
}

async function speakWithSystemVoice(config: TtsConfig, text: string) {
  const voice = config.voice ?? config.edge_tts?.voice
  const rate = Math.max(-10, Math.min(10, Math.round(percentNumber(config.edge_tts?.rate) / 10)))
  const volume = Math.max(0, Math.min(100, 100 + percentNumber(config.edge_tts?.volume)))
  if (process.platform === "win32") {
    const textPath = path.join(os.tmpdir(), `opencode-tts-${Date.now()}.txt`)
    writeFileSync(textPath, text, "utf8")
    try {
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "if ($env:OPENCODE_TTS_VOICE) { $s.SelectVoice($env:OPENCODE_TTS_VOICE) }",
        "$s.Rate = [int]$env:OPENCODE_TTS_RATE",
        "$s.Volume = [int]$env:OPENCODE_TTS_VOLUME",
        "$s.Speak([IO.File]::ReadAllText($env:OPENCODE_TTS_TEXT))",
      ].join("; ")
      await run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], false, {
        OPENCODE_TTS_TEXT: textPath,
        OPENCODE_TTS_VOICE: voice ?? "",
        OPENCODE_TTS_RATE: String(rate),
        OPENCODE_TTS_VOLUME: String(volume),
      })
    } finally {
      try {
        unlinkSync(textPath)
      } catch {}
    }
    return
  }

  if (process.platform === "darwin") {
    await run("say", [
      ...(voice ? ["-v", voice] : []),
      "-r",
      String(200 + percentNumber(config.edge_tts?.rate) * 2),
      text,
    ])
    return
  }

  await run("espeak", [
    ...(voice ? ["-v", voice] : []),
    "-s",
    String(175 + percentNumber(config.edge_tts?.rate) * 2),
    "-a",
    String(volume),
    text,
  ])
}

function startPlayback(player: string | undefined, audioPath: string, offsetMs: number) {
  const seekMs = playbackBoundaryMs.length > 0 ? Math.max(0, offsetMs) : Math.max(0, offsetMs - 300)
  const seek = seekMs > 500 ? ["-ss", (seekMs / 1000).toFixed(2)] : []
  let child: ChildProcess
  if (player === WINDOWS_SOUND_PLAYER) {
    child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System; $p = New-Object System.Media.SoundPlayer($env:OPENCODE_TTS_AUDIO); $p.PlaySync()",
      ],
      { windowsHide: true, env: { ...process.env, OPENCODE_TTS_AUDIO: audioPath } },
    )
  } else if (player === MACOS_SOUND_PLAYER) {
    child = spawn("afplay", [audioPath], { windowsHide: true })
  } else if (player === LINUX_SOUND_PLAYER) {
    child = spawn(
      "sh",
      [
        "-c",
        'if command -v paplay >/dev/null 2>&1; then exec paplay "$1"; fi; if command -v aplay >/dev/null 2>&1; then exec aplay "$1"; fi; if command -v ffplay >/dev/null 2>&1; then exec ffplay -nodisp -autoexit -loglevel quiet "$1"; fi; exit 127',
        "opencode-tts",
        audioPath,
      ],
      { windowsHide: true },
    )
  } else {
    child = spawn(player ?? "ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", ...seek, audioPath], {
      windowsHide: true,
    })
  }
  playback = child
  playbackState = "playing"
  playbackStartedAt = Date.now()
  child.on("error", () => {
    if (playback !== child) return
    stopPlayback()
  })
  child.on("close", () => {
    if (playback !== child) return
    stopPlayback()
  })
}

function defaultEdgePlayer() {
  if (process.platform === "win32") return WINDOWS_SOUND_PLAYER
  if (process.platform === "darwin") return MACOS_SOUND_PLAYER
  return LINUX_SOUND_PLAYER
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function edgeHeaders(path: string, requestID?: string, contentType?: string) {
  return [
    requestID ? `X-RequestId:${requestID}` : undefined,
    contentType ? `Content-Type:${contentType}` : undefined,
    `X-Timestamp:${new Date().toISOString()}`,
    `Path:${path}`,
    "",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\r\n")
}

function edgeSSML(config: TtsConfig, text: string, voice: string) {
  const locale = voice.split("-").slice(0, 2).join("-") || "zh-CN"
  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}">`,
    `<voice name="${escapeXml(voice)}">`,
    `<prosody rate="${escapeXml(config.edge_tts?.rate ?? "+0%")}" volume="${escapeXml(config.edge_tts?.volume ?? "+0%")}">`,
    escapeXml(text),
    "</prosody>",
    "</voice>",
    "</speak>",
  ].join("")
}

function rawDataBuffer(data: WebSocket.RawData) {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

function edgeAudioChunk(data: WebSocket.RawData) {
  const buffer = rawDataBuffer(data)
  const marker = Buffer.from("\r\n\r\n")
  const index = buffer.indexOf(marker)
  if (index < 0) return buffer
  const header = buffer.subarray(0, index).toString("utf8")
  if (!header.includes("Path:audio")) return Buffer.alloc(0)
  return buffer.subarray(index + marker.length)
}

async function synthesizeWithEdgeTts(config: TtsConfig, text: string, out: string) {
  const requestID = randomUUID().replace(/-/g, "")
  const connectionID = randomUUID().replace(/-/g, "")
  const voice = config.edge_tts?.voice ?? config.voice ?? "zh-CN-XiaoxiaoNeural"
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TTS_TOKEN}&ConnectionId=${connectionID}`

  const audio = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = new WebSocket(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      },
    })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error("edge_tts timed out"))
    }, 30_000)

    socket.on("open", () => {
      socket.send(
        `${edgeHeaders("speech.config", undefined, "application/json; charset=utf-8")}${JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: false,
                  wordBoundaryEnabled: false,
                },
                outputFormat: EDGE_TTS_FORMAT,
              },
            },
          },
        })}`,
      )
      socket.send(`${edgeHeaders("ssml", requestID, "application/ssml+xml")}${edgeSSML(config, text, voice)}`)
    })
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const chunk = edgeAudioChunk(data)
        if (chunk.length > 0) chunks.push(chunk)
        return
      }
      if (rawDataBuffer(data).toString("utf8").includes("Path:turn.end")) {
        clearTimeout(timer)
        socket.close()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on("close", () => {
      clearTimeout(timer)
      if (chunks.length === 0) reject(new Error("edge_tts returned no audio"))
    })
  })

  if (audio.length === 0) throw new Error("edge_tts returned empty audio")
  writeFileSync(out, audio)
  return voice
}

function speechText(value?: string) {
  return (value ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " 代码片段。 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~#|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function percentNumber(value: string | undefined, fallback = 0) {
  const parsed = Number(String(value ?? fallback).replace("%", ""))
  return Number.isFinite(parsed) ? parsed : fallback
}

async function speak(text: string, messageID?: string) {
  const config = readTtsConfig()
  const clean = speechText(text)
  if (!clean) return
  stopPlayback()
  playbackState = "playing"
  playbackMessageID = messageID
  debugLog(config, "speak:start", {
    backend: config.backend ?? "edge_tts",
    voice: config.voice ?? config.edge_tts?.voice,
  })
  const id = Date.now()
  const out = path.join(os.tmpdir(), `opencode-tts-${id}.wav`)
  const subtitles = path.join(os.tmpdir(), `opencode-tts-${id}.vtt`)
  try {
    if (config.backend === "say") {
      await speakWithSystemVoice(config, clean)
      playbackState = "idle"
      playbackMessageID = undefined
      debugLog(config, "speak:done", { backend: "say" })
      return
    }
    const voice = await synthesizeWithEdgeTts(config, clean, out)
    playbackAudioPath = out
    playbackPlayer = config.edge_tts?.player ?? defaultEdgePlayer()
    playbackOffsetMs = 0
    playbackBoundaryMs = readSubtitleBoundaries(subtitles)
    startPlayback(playbackPlayer, playbackAudioPath, playbackOffsetMs)
    debugLog(config, "speak:playback", { player: playbackPlayer, voice })
  } catch (error) {
    if (!playback) {
      playbackState = "idle"
      playbackMessageID = undefined
      playbackAudioPath = undefined
      playbackPlayer = undefined
      playbackOffsetMs = 0
      playbackStartedAt = 0
      playbackBoundaryMs = []
    }
    try {
      unlinkSync(out)
    } catch {}
    try {
      unlinkSync(subtitles)
    } catch {}
    debugLog(config, "speak:error", error instanceof Error ? error.message : String(error))
    throw error
  }
  try {
    unlinkSync(subtitles)
  } catch {}
}

export const desktopHandlers = HttpApiBuilder.group(InstanceHttpApi, "desktop", (handlers) =>
  Effect.gen(function* () {
    const actions = Effect.fn("DesktopHttpApi.actions")(function* () {
      const config = readTtsConfig()
      return [
        { id: "tts.speak-message", location: "assistant-message" as const, label: "朗读", icon: "play" as const },
        { id: "tts.pause-toggle", location: "assistant-message" as const, label: "暂停/继续", icon: "play" as const },
        {
          id: "tts.toggle",
          location: "composer" as const,
          label: "TTS",
          icon: "volume" as const,
          active: config.enabled !== false,
        },
      ]
    })

    const ttsState = Effect.fn("DesktopHttpApi.ttsState")(function* () {
      return {
        state: playbackState,
        messageID: playbackMessageID,
      }
    })

    const action = Effect.fn("DesktopHttpApi.action")(function* (ctx: {
      payload: typeof DesktopActionInvokePayload.Type
    }) {
      return yield* Effect.tryPromise({
        try: async () => {
          if (ctx.payload.id === "tts.stop") {
            stopPlayback()
            return { handled: true }
          }
          if (ctx.payload.id === "tts.pause-toggle") {
            return { handled: togglePlaybackPause() }
          }
          if (ctx.payload.id === "tts.toggle") {
            const config = readTtsConfig()
            writeTtsConfig({ ...config, enabled: config.enabled === false })
            return { handled: true }
          }
          if (ctx.payload.id === "tts.speak-message") {
            await speak(ctx.payload.text ?? "", ctx.payload.messageID)
            return { handled: true }
          }
          return { handled: false }
        },
        catch: (error) => {
          const config = readTtsConfig()
          debugLog(config, "action:error", error instanceof Error ? error.message : String(error))
          return new HttpApiError.BadRequest({})
        },
      })
    })

    return handlers.handle("actions", actions).handle("ttsState", ttsState).handle("action", action)
  }),
)
