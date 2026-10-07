import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export type DesktopAction = {
  id: string
  location: "assistant-message" | "composer"
  label: string
  icon?: "play" | "pause" | "stop" | "volume" | "volume-off"
  active?: boolean
  command?: string
}

export type DesktopTtsState = {
  state: "idle" | "playing" | "paused"
  messageID?: string
}

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return undefined
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

function url(server: ServerConnection.HttpBase, path: string, directory: string) {
  const result = new URL(path, server.url)
  result.searchParams.set("directory", directory)
  return result
}

export async function listDesktopActions(input: { server: ServerConnection.HttpBase; directory: string }) {
  const response = await fetch(url(input.server, "/desktop/actions", input.directory), {
    headers: headers(input.server),
  })
  if (!response.ok) throw new Error(`Desktop actions failed: ${response.status}`)
  return (await response.json()) as DesktopAction[]
}

export async function invokeDesktopAction(input: {
  server: ServerConnection.HttpBase
  directory: string
  action: { id: string; sessionID?: string; messageID?: string; text?: string }
}) {
  const response = await fetch(url(input.server, "/desktop/action", input.directory), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(input.server),
    },
    body: JSON.stringify(input.action),
  })
  if (!response.ok) throw new Error(`Desktop action failed: ${response.status}`)
  return (await response.json()) as { handled: boolean }
}

export async function getDesktopTtsState(input: { server: ServerConnection.HttpBase; directory: string }) {
  const response = await fetch(url(input.server, "/desktop/tts-state", input.directory), {
    headers: headers(input.server),
  })
  if (!response.ok) throw new Error(`Desktop TTS state failed: ${response.status}`)
  return (await response.json()) as DesktopTtsState
}
