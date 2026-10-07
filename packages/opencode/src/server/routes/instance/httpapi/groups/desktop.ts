import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const DesktopAction = Schema.Struct({
  id: Schema.String,
  location: Schema.Literals(["assistant-message", "composer"]),
  label: Schema.String,
  icon: Schema.optional(Schema.Literals(["play", "pause", "stop", "volume", "volume-off"])),
  active: Schema.optional(Schema.Boolean),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "DesktopAction" })

export const DesktopActionInvokePayload = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
}).annotate({ identifier: "DesktopActionInvokePayload" })

export const DesktopTtsState = Schema.Struct({
  state: Schema.Literals(["idle", "playing", "paused"]),
  messageID: Schema.optional(Schema.String),
}).annotate({ identifier: "DesktopTtsState" })

const root = "/desktop"

export const DesktopPaths = {
  actions: `${root}/actions`,
  action: `${root}/action`,
  ttsState: `${root}/tts-state`,
} as const

export const DesktopApi = HttpApi.make("desktop").add(
  HttpApiGroup.make("desktop")
    .add(
      HttpApiEndpoint.get("actions", DesktopPaths.actions, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Any, "Desktop plugin actions"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "desktop.actions",
          summary: "List desktop actions",
          description: "List plugin-provided desktop UI actions.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("ttsState", DesktopPaths.ttsState, {
        query: WorkspaceRoutingQuery,
        success: described(DesktopTtsState, "Desktop TTS playback state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "desktop.ttsState",
          summary: "Get desktop TTS state",
          description: "Get the current desktop TTS playback state.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("action", DesktopPaths.action, {
        query: WorkspaceRoutingQuery,
        payload: DesktopActionInvokePayload,
        success: described(Schema.Struct({ handled: Schema.Boolean }), "Desktop action invocation result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "desktop.action",
          summary: "Invoke desktop action",
          description: "Invoke a plugin-provided desktop UI action.",
        }),
      ),
    ),
)
