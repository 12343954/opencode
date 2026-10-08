import { Config } from "@/config/config"
import type { ConfigPlugin } from "@/config/plugin"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { applyEdits, modify, parse } from "jsonc-parser"
import fs from "node:fs/promises"
import path from "node:path"
import { InstanceHttpApi } from "../api"
import { TtsPluginSettings } from "../groups/plugin-settings"

const TTS_CONFIG_PATH = path.join(Global.Path.config, "plugins", "opencode-tts.jsonc")
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

function specText(spec: unknown) {
  return Array.isArray(spec) ? String(spec[0] ?? "") : String(spec ?? "")
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
      ...(current.edge_tts ?? {}),
      ...(patch.edge_tts ?? {}),
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
      .handle("uninstall", uninstall)
  }),
)
