import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs/promises"
import path from "node:path"
import { InstanceHttpApi } from "../api"
import { TtsPluginSettings } from "../groups/plugin-settings"

const TTS_CONFIG_PATH = path.join(Global.Path.config, "plugins", "opencode-tts.jsonc")

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

export const pluginSettingsHandlers = HttpApiBuilder.group(InstanceHttpApi, "pluginSettings", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const list = Effect.fn("PluginSettingsHttpApi.list")(function* () {
      const cfg = yield* config.get()
      const origins = cfg.plugin_origins ?? (cfg.plugin ?? []).map((spec) => ({ spec }))
      return origins.map((origin: any) => {
        const spec = specText(origin.spec)
        const id = pluginID(spec)
        return {
          id,
          spec,
          source: origin.source,
          configurable: id === "opencode-tts-speak" || id === "opencode-tts",
        }
      })
    })

    const tts = Effect.fn("PluginSettingsHttpApi.tts")(function* () {
      return yield* Effect.promise(readTtsConfig)
    })

    const ttsUpdate = Effect.fn("PluginSettingsHttpApi.ttsUpdate")(function* (ctx: {
      payload: typeof TtsPluginSettings.Type
    }) {
      return yield* Effect.promise(() => writeTtsConfig(ctx.payload))
    })

    return handlers.handle("list", list).handle("tts", tts).handle("ttsUpdate", ttsUpdate)
  }),
)
