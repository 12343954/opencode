import { Config } from "@/config/config"
import type { ConfigPlugin } from "@/config/plugin"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { applyEdits, modify, parse } from "jsonc-parser"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { InstanceHttpApi } from "../api"
import { TtsPluginSettings } from "../groups/plugin-settings"

const TTS_CONFIG_PATH = path.join(Global.Path.config, "plugins", "opencode-tts.jsonc")
const TTS_LOG_PATH = path.join(Global.Path.config, "plugins", "opencode-tts.log")
const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
const EDGE_TTS_SEC_MS_GEC_VERSION = "1-142.0.3595.94"
const WIN_EPOCH_SECONDS = 11_644_473_600
const execFileAsync = promisify(execFile)
type TtsVoice = { id: string; name: string; language?: string }
const BUILTIN_PLUGINS = [
  "codex-auth",
  "github-copilot",
  "modal",
  "gitlab-auth",
  "poe-auth",
  "cloudflare-workers",
  "cloudflare-ai-gateway",
  "azure",
  "digitalocean",
  "snowflake-cortex",
  "xai",
  "cerebras",
]

function stripJsonComments(value: string) {
  return value.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function unknownString(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""
}

function specText(spec: unknown) {
  return Array.isArray(spec) ? unknownString(spec[0]) : unknownString(spec)
}

function pluginID(spec: string) {
  if (spec.includes("opencode-tts-speak")) return "opencode-tts-speak"
  if (spec.includes("opencode-tts")) return "opencode-tts"
  if (spec.startsWith("file://")) return path.basename(spec).replace(/\.(mjs|cjs|js|ts)$/i, "")
  if (spec.startsWith("@")) {
    const index = spec.lastIndexOf("@")
    return index > 0 ? spec.slice(0, index) : spec
  }
  return spec.split("@")[0] || spec
}

async function readTtsConfig() {
  try {
    return JSON.parse(stripJsonComments(await fs.readFile(TTS_CONFIG_PATH, "utf8"))) as typeof TtsPluginSettings.Type
  } catch {
    return {} as typeof TtsPluginSettings.Type
  }
}

async function writeTtsConfig(patch: typeof TtsPluginSettings.Type) {
  const current = await readTtsConfig()
  const next = {
    ...current,
    ...patch,
    edge_tts: {
      ...current.edge_tts,
      ...patch.edge_tts,
    },
  }
  await fs.mkdir(path.dirname(TTS_CONFIG_PATH), { recursive: true })
  await fs.writeFile(TTS_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8")
  return next
}

function isWritableUserConfig(source?: string) {
  if (!source) return false
  if (!/\.(jsonc?|JSONC?)$/.test(source)) return false
  if (source.startsWith("http://") || source.startsWith("https://")) return false
  if (source === "OPENCODE_CONFIG_CONTENT") return false
  return true
}

async function installedAt(source?: string) {
  if (!source) return undefined
  try {
    return (await fs.stat(source)).mtimeMs
  } catch {
    return undefined
  }
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  if (!value.trim()) return []
  const parsed = JSON.parse(value) as unknown
  if (Array.isArray(parsed))
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
  if (parsed && typeof parsed === "object") return [Object.fromEntries(Object.entries(parsed))]
  return []
}

async function systemVoices(): Promise<TtsVoice[]> {
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "$s.GetInstalledVoices() | ForEach-Object { $i = $_.VoiceInfo; [pscustomobject]@{ id = $i.Name; name = $i.Name; language = $i.Culture.Name } } | ConvertTo-Json -Compress",
      ].join("; ")
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
        windowsHide: true,
      })
      return parseJsonArray(stdout)
        .map((voice): TtsVoice => {
          const language = unknownString(voice.language) || undefined
          return {
            id: unknownString(voice.id) || unknownString(voice.name),
            name: unknownString(voice.name) || unknownString(voice.id),
            ...(language ? { language } : {}),
          }
        })
        .filter((voice) => voice.id && voice.name)
    }

    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("say", ["-v", "?"], { windowsHide: true })
      return stdout.split(/\r?\n/).flatMap((line): TtsVoice[] => {
        const match = line.match(/^(.{1,24}?)\s{2,}([A-Za-z_-]+)\s+#?\s*(.*)$/)
        if (!match) return []
        const name = match[1].trim()
        return [{ id: name, name: match[3]?.trim() ? `${name} - ${match[3].trim()}` : name, language: match[2] }]
      })
    }

    const { stdout } = await execFileAsync("espeak", ["--voices"], { windowsHide: true })
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 4)
      .map((parts) => ({ id: parts[3], name: parts[3], language: parts[1] }))
  } catch {
    return []
  }
}

async function edgeVoices(): Promise<TtsVoice[]> {
  try {
    let seconds = Math.floor(Date.now() / 1000) + WIN_EPOCH_SECONDS
    seconds -= seconds % 300
    const filetime = BigInt(seconds) * 10_000_000n
    const secMsGec = createHash("sha256")
      .update(`${filetime}${EDGE_TTS_TOKEN}`, "ascii")
      .digest("hex")
      .toUpperCase()
    const response = await fetch(
      `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TTS_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${EDGE_TTS_SEC_MS_GEC_VERSION}`,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
        },
      },
    )
    if (!response.ok) return []
    const parsed = (await response.json()) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((voice): TtsVoice => {
        const id = unknownString(voice.ShortName)
        const name = unknownString(voice.FriendlyName) || unknownString(voice.LocalName) || id
        const language = unknownString(voice.Locale) || undefined
        return { id, name, ...(language ? { language } : {}) }
      })
      .filter((voice) => voice.id && voice.name)
  } catch {
    return []
  }
}

function uniqueVoices(voices: TtsVoice[]) {
  const seen = new Set<string>()
  return voices.filter((voice) => {
    if (seen.has(voice.id)) return false
    seen.add(voice.id)
    return true
  })
}

async function removePluginFromConfig(source: string, id: string) {
  const text = await fs.readFile(source, "utf8")
  const parsed = parse(text) as { plugin?: unknown[] }
  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : []
  const next = plugins.filter((spec) => pluginID(specText(spec)) !== id)
  if (next.length === plugins.length) return false

  const edits = modify(text, ["plugin"], next, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  })
  await fs.writeFile(source, applyEdits(text, edits), "utf8")
  return true
}

export const pluginSettingsHandlers = HttpApiBuilder.group(InstanceHttpApi, "pluginSettings", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const list = Effect.fn("PluginSettingsHttpApi.list")(function* () {
      const cfg = yield* config.get()
      const origins = cfg.plugin_origins ?? (cfg.plugin ?? []).map((spec) => ({ spec }))
      const configured = yield* Effect.forEach(origins, (origin) =>
        Effect.promise(async () => {
          const typed = origin as Partial<ConfigPlugin.Origin> & { spec: unknown }
          const spec = specText(typed.spec)
          const id = pluginID(spec)
          return {
            id,
            spec,
            source: typed.source,
            scope: typed.scope,
            installedAt: await installedAt(typed.source),
            configurable: id === "opencode-tts-speak" || id === "opencode-tts",
            uninstallable: isWritableUserConfig(typed.source),
          }
        }),
      )
      const configuredIDs = new Set(configured.map((plugin) => plugin.id))
      return [
        ...BUILTIN_PLUGINS.filter((id) => !configuredIDs.has(id)).map((id) => ({
          id,
          spec: `builtin:${id}`,
          source: "opencode",
          scope: "global" as const,
          configurable: false,
          uninstallable: false,
        })),
        ...configured,
      ]
    })

    const tts = Effect.fn("PluginSettingsHttpApi.tts")(function* () {
      return yield* Effect.promise(readTtsConfig)
    })

    const ttsUpdate = Effect.fn("PluginSettingsHttpApi.ttsUpdate")(function* (ctx: {
      payload: typeof TtsPluginSettings.Type
    }) {
      return yield* Effect.promise(() => writeTtsConfig(ctx.payload))
    })

    const ttsInfo = Effect.fn("PluginSettingsHttpApi.ttsInfo")(function* () {
      return yield* Effect.promise(async () => ({
        voices: uniqueVoices([...(await edgeVoices()), ...(await systemVoices())]),
        logPath: TTS_LOG_PATH,
      }))
    })

    const ttsLog = Effect.fn("PluginSettingsHttpApi.ttsLog")(function* () {
      return yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(TTS_LOG_PATH), { recursive: true })
        await fs.appendFile(TTS_LOG_PATH, "", "utf8")
        return TTS_LOG_PATH
      })
    })

    const uninstall = Effect.fn("PluginSettingsHttpApi.uninstall")(function* (ctx: { payload: { id: string } }) {
      const cfg = yield* config.get()
      const origins = cfg.plugin_origins ?? (cfg.plugin ?? []).map((spec) => ({ spec }))
      const origin = origins.find((item) => pluginID(specText(item.spec)) === ctx.payload.id) as
        | (Partial<ConfigPlugin.Origin> & { spec: unknown })
        | undefined
      if (!origin || !isWritableUserConfig(origin.source)) return false
      const removed = yield* Effect.promise(() => removePluginFromConfig(origin.source!, ctx.payload.id))
      if (removed) yield* config.invalidate()
      return removed
    })

    return handlers
      .handle("list", list)
      .handle("tts", tts)
      .handle("ttsUpdate", ttsUpdate)
      .handle("ttsInfo", ttsInfo)
      .handle("ttsLog", ttsLog)
      .handle("uninstall", uninstall)
  }),
)
