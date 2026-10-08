import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
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
const VENV_PYTHON = path.join(
  OPENCODE_DIR,
  "tts-venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
)
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
  if (playbackState === "paused" && playbackAudioPath && playbackPlayer) {
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

function startPlayback(player: string, audioPath: string, offsetMs: number) {
  const seekMs = playbackBoundaryMs.length > 0 ? Math.max(0, offsetMs) : Math.max(0, offsetMs - 300)
  const seek = seekMs > 500 ? ["-ss", (seekMs / 1000).toFixed(2)] : []
  const child = spawn(player, ["-nodisp", "-autoexit", "-loglevel", "quiet", ...seek, audioPath], { windowsHide: true })
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
  const out = path.join(os.tmpdir(), `opencode-tts-${id}.mp3`)
  const subtitles = path.join(os.tmpdir(), `opencode-tts-${id}.vtt`)
  try {
    if (config.backend === "say") {
      await speakWithSystemVoice(config, clean)
      playbackState = "idle"
      playbackMessageID = undefined
      debugLog(config, "speak:done", { backend: "say" })
      return
    }
    const voice = config.edge_tts?.voice ?? config.voice ?? "zh-CN-XiaoxiaoNeural"
    await run(VENV_PYTHON, [
      "-m",
      "edge_tts",
      "--voice",
      voice,
      "--rate",
      config.edge_tts?.rate ?? "+0%",
      "--volume",
      config.edge_tts?.volume ?? "+0%",
      "--text",
      clean,
      "--write-media",
      out,
      "--write-subtitles",
      subtitles,
    ])
    playbackAudioPath = out
    playbackPlayer = config.edge_tts?.player ?? "ffplay"
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
        catch: (error) => error,
      }).pipe(Effect.catch(() => Effect.succeed({ handled: false })))
    })

    return handlers.handle("actions", actions).handle("ttsState", ttsState).handle("action", action)
  }),
)
