import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

export type PluginSettingsInfo = {
  id: string
  spec: string
  source?: string
  scope?: "global" | "local"
  installedAt?: number
  configurable: boolean
  uninstallable: boolean
}

export type TtsPluginSettings = {
  enabled?: boolean
  mode?: "full" | "summary"
  debug?: boolean
  backend?: "edge_tts" | "say"
  voice?: string
  summaryLength?: string
  edge_tts?: {
    player?: string
    voice?: string
    rate?: string
    volume?: string
  }
}

export type TtsVoiceInfo = {
  id: string
  name: string
  language?: string
}

export type TtsPluginInfo = {
  voices: TtsVoiceInfo[]
  logPath: string
}

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return undefined
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

function url(server: ServerConnection.HttpBase, path: string, directory?: string) {
  const result = new URL(path, server.url)
  if (directory) result.searchParams.set("directory", directory)
  return result
}

export async function listPluginSettings(input: { server: ServerConnection.HttpBase; directory?: string }) {
  const response = await fetch(url(input.server, "/plugin-settings", input.directory), {
    headers: headers(input.server),
  })
  if (!response.ok) throw new Error(`Plugin settings failed: ${response.status}`)
  return (await response.json()) as PluginSettingsInfo[]
}

export async function getTtsPluginSettings(input: { server: ServerConnection.HttpBase; directory?: string }) {
  const response = await fetch(url(input.server, "/plugin-settings/tts", input.directory), {
    headers: headers(input.server),
  })
  if (!response.ok) throw new Error(`TTS settings failed: ${response.status}`)
  return (await response.json()) as TtsPluginSettings
}

export async function getTtsPluginInfo(input: { server: ServerConnection.HttpBase; directory?: string }) {
  const response = await fetch(url(input.server, "/plugin-settings/tts/info", input.directory), {
    headers: headers(input.server),
  })
  if (!response.ok) throw new Error(`TTS info failed: ${response.status}`)
  return (await response.json()) as TtsPluginInfo
}

export async function updateTtsPluginSettings(input: {
  server: ServerConnection.HttpBase
  directory?: string
  settings: TtsPluginSettings
}) {
  const response = await fetch(url(input.server, "/plugin-settings/tts", input.directory), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...headers(input.server),
    },
    body: JSON.stringify(input.settings),
  })
  if (!response.ok) throw new Error(`TTS settings update failed: ${response.status}`)
  return (await response.json()) as TtsPluginSettings
}

export async function uninstallPlugin(input: { server: ServerConnection.HttpBase; directory?: string; id: string }) {
  const response = await fetch(url(input.server, "/plugin-settings/uninstall", input.directory), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(input.server),
    },
    body: JSON.stringify({ id: input.id }),
  })
  if (!response.ok) throw new Error(`Plugin uninstall failed: ${response.status}`)
  return (await response.json()) as boolean
}
