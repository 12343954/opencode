import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/plugin-settings"

export const PluginSettingsInfo = Schema.Struct({
  id: Schema.String,
  spec: Schema.String,
  source: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["global", "local"])),
  installedAt: Schema.optional(Schema.Number),
  configurable: Schema.Boolean,
  uninstallable: Schema.Boolean,
}).annotate({ identifier: "PluginSettingsInfo" })

export const PluginSettingsUninstallInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "PluginSettingsUninstallInput" })

export const TtsPluginSettings = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literals(["full", "summary"])),
  debug: Schema.optional(Schema.Boolean),
  backend: Schema.optional(Schema.Literals(["edge_tts", "say"])),
  voice: Schema.optional(Schema.String),
  summaryLength: Schema.optional(Schema.String),
  edge_tts: Schema.optional(
    Schema.Struct({
      player: Schema.optional(Schema.String),
      voice: Schema.optional(Schema.String),
      rate: Schema.optional(Schema.String),
      volume: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "TtsPluginSettings" })

export const TtsVoiceInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  language: Schema.optional(Schema.String),
}).annotate({ identifier: "TtsVoiceInfo" })

export const TtsPluginInfo = Schema.Struct({
  voices: Schema.Array(TtsVoiceInfo),
  logPath: Schema.String,
}).annotate({ identifier: "TtsPluginInfo" })

export const PluginSettingsApi = HttpApi.make("pluginSettings").add(
  HttpApiGroup.make("pluginSettings")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(PluginSettingsInfo), "Configured plugins"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginSettings.list",
          summary: "List plugins",
          description: "List configured OpenCode plugins.",
        }),
      ),
      HttpApiEndpoint.get("tts", `${root}/tts`, {
        query: WorkspaceRoutingQuery,
        success: described(TtsPluginSettings, "TTS plugin settings"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginSettings.tts",
          summary: "Get TTS plugin settings",
          description: "Read opencode-tts-speak settings.",
        }),
      ),
      HttpApiEndpoint.patch("ttsUpdate", `${root}/tts`, {
        query: WorkspaceRoutingQuery,
        payload: TtsPluginSettings,
        success: described(TtsPluginSettings, "Updated TTS plugin settings"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginSettings.ttsUpdate",
          summary: "Update TTS plugin settings",
          description: "Update opencode-tts-speak settings.",
        }),
      ),
      HttpApiEndpoint.get("ttsInfo", `${root}/tts/info`, {
        query: WorkspaceRoutingQuery,
        success: described(TtsPluginInfo, "TTS plugin metadata"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginSettings.ttsInfo",
          summary: "Get TTS plugin metadata",
          description: "List system TTS voices and related paths.",
        }),
      ),
      HttpApiEndpoint.post("uninstall", `${root}/uninstall`, {
        query: WorkspaceRoutingQuery,
        payload: PluginSettingsUninstallInput,
        success: described(Schema.Boolean, "Whether the plugin was uninstalled"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pluginSettings.uninstall",
          summary: "Uninstall plugin",
          description: "Remove a configured plugin from its writable config file.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
