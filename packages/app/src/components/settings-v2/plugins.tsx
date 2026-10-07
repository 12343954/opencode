import { createMemo, createSignal, For, Show, type Accessor, type Component } from "solid-js"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import {
  getTtsPluginSettings,
  listPluginSettings,
  updateTtsPluginSettings,
  type TtsPluginSettings,
} from "@/utils/plugin-settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const modeOptions = ["summary", "full"] as const
const backendOptions = ["edge_tts", "say"] as const

export const SettingsPluginsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const server = useServerSDK()
  const queryClient = useQueryClient()
  const [saving, setSaving] = createSignal(false)

  const plugins = createQuery(() => ({
    queryKey: [server().scope, props.directory(), "plugin-settings"] as const,
    queryFn: () => listPluginSettings({ server: server().server.http, directory: props.directory() }),
  }))

  const tts = createQuery(() => ({
    queryKey: [server().scope, props.directory(), "plugin-settings", "tts"] as const,
    queryFn: () => getTtsPluginSettings({ server: server().server.http, directory: props.directory() }),
  }))

  const hasTts = createMemo(() =>
    (plugins.data ?? []).some((plugin) => plugin.id === "opencode-tts-speak" || plugin.id === "opencode-tts"),
  )

  const save = (patch: TtsPluginSettings) => {
    const current = tts.data ?? {}
    const next = {
      ...current,
      ...patch,
      edge_tts: {
        ...(current.edge_tts ?? {}),
        ...(patch.edge_tts ?? {}),
      },
    }
    setSaving(true)
    void updateTtsPluginSettings({
      server: server().server.http,
      directory: props.directory(),
      settings: next,
    })
      .then(() => {
        queryClient.setQueryData([server().scope, props.directory(), "plugin-settings", "tts"], next)
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setSaving(false))
  }

  const text = (value: string | undefined, fallback = "") => value ?? fallback

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.plugins.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-plugins">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.plugins.section.configured")}</h3>
          <SettingsListV2>
            <Show
              when={(plugins.data ?? []).length > 0}
              fallback={<div class="settings-v2-plugin-empty">{language.t("settings.plugins.empty")}</div>}
            >
              <For each={plugins.data ?? []}>
                {(plugin) => (
                  <div class="settings-v2-plugin-row">
                    <div class="settings-v2-plugin-copy">
                      <span class="settings-v2-plugin-name">{plugin.id}</span>
                      <span class="settings-v2-plugin-spec">{plugin.spec}</span>
                    </div>
                    <Show when={plugin.configurable}>
                      <span class="settings-v2-plugin-tag">{language.t("settings.plugins.configurable")}</span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <Show when={hasTts()}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">opencode-tts-speak</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.plugins.tts.enabled.title")}
                description={language.t("settings.plugins.tts.enabled.description")}
              >
                <Switch
                  checked={tts.data?.enabled !== false}
                  disabled={saving()}
                  onChange={(value) => save({ enabled: value })}
                />
              </SettingsRowV2>

              <SettingsRowV2
                title={language.t("settings.plugins.tts.mode.title")}
                description={language.t("settings.plugins.tts.mode.description")}
              >
                <SelectV2
                  appearance="inline"
                  options={[...modeOptions]}
                  current={tts.data?.mode ?? "summary"}
                  label={(option) => language.t(`settings.plugins.tts.mode.${option}`)}
                  onSelect={(value) => value && save({ mode: value })}
                />
              </SettingsRowV2>

              <SettingsRowV2
                title={language.t("settings.plugins.tts.backend.title")}
                description={language.t("settings.plugins.tts.backend.description")}
              >
                <SelectV2
                  appearance="inline"
                  options={[...backendOptions]}
                  current={tts.data?.backend ?? "edge_tts"}
                  label={(option) => option}
                  onSelect={(value) => value && save({ backend: value })}
                />
              </SettingsRowV2>

              <SettingsRowV2
                title={language.t("settings.plugins.tts.player.title")}
                description={language.t("settings.plugins.tts.player.description")}
              >
                <div class="w-full sm:w-[360px]">
                  <TextInputV2
                    appearance="base"
                    value={text(tts.data?.edge_tts?.player)}
                    placeholder="ffplay"
                    disabled={saving()}
                    spellcheck={false}
                    onChange={(event) => save({ edge_tts: { player: event.currentTarget.value.trim() || undefined } })}
                  />
                </div>
              </SettingsRowV2>

              <SettingsRowV2
                title={language.t("settings.plugins.tts.voice.title")}
                description={language.t("settings.plugins.tts.voice.description")}
              >
                <div class="w-full sm:w-[260px]">
                  <TextInputV2
                    appearance="base"
                    value={text(tts.data?.voice ?? tts.data?.edge_tts?.voice)}
                    placeholder="zh-CN-XiaoxiaoNeural"
                    disabled={saving()}
                    spellcheck={false}
                    onChange={(event) => save({ voice: event.currentTarget.value.trim() || undefined })}
                  />
                </div>
              </SettingsRowV2>

              <SettingsRowV2 title="Rate" description={language.t("settings.plugins.tts.rate.description")}>
                <div class="w-full sm:w-[120px]">
                  <TextInputV2
                    appearance="base"
                    value={text(tts.data?.edge_tts?.rate, "+0%")}
                    placeholder="+0%"
                    disabled={saving()}
                    onChange={(event) => save({ edge_tts: { rate: event.currentTarget.value.trim() || undefined } })}
                  />
                </div>
              </SettingsRowV2>

              <SettingsRowV2 title="Volume" description={language.t("settings.plugins.tts.volume.description")}>
                <div class="w-full sm:w-[120px]">
                  <TextInputV2
                    appearance="base"
                    value={text(tts.data?.edge_tts?.volume, "+0%")}
                    placeholder="+0%"
                    disabled={saving()}
                    onChange={(event) => save({ edge_tts: { volume: event.currentTarget.value.trim() || undefined } })}
                  />
                </div>
              </SettingsRowV2>

              <SettingsRowV2
                title={language.t("settings.plugins.tts.debug.title")}
                description={language.t("settings.plugins.tts.debug.description")}
              >
                <Switch checked={tts.data?.debug === true} disabled={saving()} onChange={(value) => save({ debug: value })} />
              </SettingsRowV2>
            </SettingsListV2>
          </div>
        </Show>

        <Show when={!hasTts() && !(plugins.isLoading || tts.isLoading)}>
          <div class="settings-v2-plugin-empty">{language.t("settings.plugins.tts.missing")}</div>
        </Show>
      </div>
    </>
  )
}
