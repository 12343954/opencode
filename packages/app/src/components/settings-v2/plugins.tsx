import {
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch as MatchSwitch,
  type Accessor,
  type Component,
} from "solid-js"
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
  uninstallPlugin,
  updateTtsPluginSettings,
  type PluginSettingsInfo,
  type TtsPluginSettings,
} from "@/utils/plugin-settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const modeOptions = ["summary", "full"] as const
const backendOptions = ["edge_tts", "say"] as const
const sortOptions = ["name", "installed"] as const

type SortOption = (typeof sortOptions)[number]

const descriptionKeys: Record<string, string> = {
  "opencode-tts-speak": "settings.plugins.description.tts",
  "opencode-tts": "settings.plugins.description.tts",
  "codex-auth": "settings.plugins.description.codexAuth",
  "github-copilot": "settings.plugins.description.githubCopilot",
  modal: "settings.plugins.description.modal",
  "gitlab-auth": "settings.plugins.description.gitlabAuth",
  "poe-auth": "settings.plugins.description.poeAuth",
  "cloudflare-workers": "settings.plugins.description.cloudflareWorkers",
  "cloudflare-ai-gateway": "settings.plugins.description.cloudflareAiGateway",
  azure: "settings.plugins.description.azure",
  digitalocean: "settings.plugins.description.digitalocean",
  "snowflake-cortex": "settings.plugins.description.snowflakeCortex",
  xai: "settings.plugins.description.xai",
  cerebras: "settings.plugins.description.cerebras",
}

export const SettingsPluginsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const server = useServerSDK()
  const queryClient = useQueryClient()
  const [saving, setSaving] = createSignal(false)
  const [removing, setRemoving] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<string>()
  const [search, setSearch] = createSignal("")
  const [sort, setSort] = createSignal<SortOption>("name")

  const pluginsQueryKey = createMemo(() => [server().scope, props.directory(), "plugin-settings"] as const)
  const ttsQueryKey = createMemo(() => [server().scope, props.directory(), "plugin-settings", "tts"] as const)

  const plugins = createQuery(() => ({
    queryKey: pluginsQueryKey(),
    queryFn: () => listPluginSettings({ server: server().server.http, directory: props.directory() }),
  }))

  const tts = createQuery(() => ({
    queryKey: ttsQueryKey(),
    queryFn: () => getTtsPluginSettings({ server: server().server.http, directory: props.directory() }),
  }))

  const description = (plugin: PluginSettingsInfo) =>
    language.t(descriptionKeys[plugin.id] ?? "settings.plugins.description.custom")

  const pluginList = createMemo(() => {
    const term = search().trim().toLowerCase()
    const list = [...(plugins.data ?? [])].filter((plugin) => {
      if (!term) return true
      return [plugin.id, plugin.spec, plugin.source, plugin.scope, description(plugin)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    })

    return list.sort((a, b) => {
      if (sort() === "installed") return (b.installedAt ?? 0) - (a.installedAt ?? 0) || a.id.localeCompare(b.id)
      return a.id.localeCompare(b.id)
    })
  })

  const hasTts = (plugin: PluginSettingsInfo) => plugin.id === "opencode-tts-speak" || plugin.id === "opencode-tts"

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
        queryClient.setQueryData(ttsQueryKey(), next)
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

  const remove = (plugin: PluginSettingsInfo) => {
    if (!plugin.uninstallable) return
    if (!window.confirm(language.t("settings.plugins.uninstall.confirm", { name: plugin.id }))) return
    setRemoving(plugin.id)
    void uninstallPlugin({ server: server().server.http, directory: props.directory(), id: plugin.id })
      .then((removed) => {
        if (!removed) throw new Error(language.t("settings.plugins.uninstall.unavailable"))
        queryClient.setQueryData(pluginsQueryKey(), (current: PluginSettingsInfo[] | undefined) =>
          (current ?? []).filter((item) => item.id !== plugin.id),
        )
        if (expanded() === plugin.id) setExpanded(undefined)
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setRemoving(undefined))
  }

  const text = (value: string | undefined, fallback = "") => value ?? fallback
  const date = (value: number | undefined) =>
    value ? new Date(value).toLocaleString() : language.t("settings.plugins.date.unknown")
  const nextSort = () => setSort(sort() === "name" ? "installed" : "name")

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.plugins.title")}</h2>
          <button type="button" class="settings-v2-plugin-sort" onClick={nextSort}>
            {language.t(`settings.plugins.sort.${sort()}`)}
            <span aria-hidden="true">v</span>
          </button>
        </div>
        <div class="settings-v2-tab-search">
          <TextInputV2
            appearance="base"
            value={search()}
            placeholder={language.t("settings.plugins.search.placeholder")}
            spellcheck={false}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-plugins">
        <SettingsListV2>
          <Show
            when={pluginList().length > 0}
            fallback={
              <div class="settings-v2-plugin-empty">
                {search().trim() ? language.t("settings.plugins.search.empty") : language.t("settings.plugins.empty")}
              </div>
            }
          >
            <For each={pluginList()}>
              {(plugin) => {
                const open = createMemo(() => expanded() === plugin.id)
                return (
                  <div class="settings-v2-plugin-accordion" data-expanded={open() ? "" : undefined}>
                    <button
                      type="button"
                      class="settings-v2-plugin-row settings-v2-plugin-trigger"
                      aria-expanded={open()}
                      onClick={() => setExpanded(open() ? undefined : plugin.id)}
                    >
                      <div class="settings-v2-plugin-copy">
                        <span class="settings-v2-plugin-name">{plugin.id}</span>
                        <span class="settings-v2-plugin-description">{description(plugin)}</span>
                      </div>
                      <div class="settings-v2-plugin-tags">
                        <Show when={plugin.configurable}>
                          <span class="settings-v2-plugin-tag">{language.t("settings.plugins.configurable")}</span>
                        </Show>
                        <span class="settings-v2-plugin-tag">
                          {plugin.scope === "local"
                            ? language.t("settings.plugins.scope.local")
                            : language.t("settings.plugins.scope.global")}
                        </span>
                        <span class="settings-v2-plugin-chevron">v</span>
                      </div>
                    </button>

                    <Show when={open()}>
                      <div class="settings-v2-plugin-panel">
                        <div class="settings-v2-plugin-meta">
                          <div>
                            <span>{language.t("settings.plugins.detail.source")}</span>
                            <strong>{plugin.source ?? language.t("settings.plugins.detail.source.unknown")}</strong>
                          </div>
                          <div>
                            <span>{language.t("settings.plugins.detail.installedAt")}</span>
                            <strong>{date(plugin.installedAt)}</strong>
                          </div>
                        </div>

                        <MatchSwitch>
                          <Match when={hasTts(plugin)}>
                            <div class="settings-v2-plugin-settings">
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
                                    onChange={(event) =>
                                      save({ edge_tts: { player: event.currentTarget.value.trim() || undefined } })
                                    }
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

                              <SettingsRowV2
                                title="Rate"
                                description={language.t("settings.plugins.tts.rate.description")}
                              >
                                <div class="w-full sm:w-[120px]">
                                  <TextInputV2
                                    appearance="base"
                                    value={text(tts.data?.edge_tts?.rate, "+0%")}
                                    placeholder="+0%"
                                    disabled={saving()}
                                    onChange={(event) =>
                                      save({ edge_tts: { rate: event.currentTarget.value.trim() || undefined } })
                                    }
                                  />
                                </div>
                              </SettingsRowV2>

                              <SettingsRowV2
                                title="Volume"
                                description={language.t("settings.plugins.tts.volume.description")}
                              >
                                <div class="w-full sm:w-[120px]">
                                  <TextInputV2
                                    appearance="base"
                                    value={text(tts.data?.edge_tts?.volume, "+0%")}
                                    placeholder="+0%"
                                    disabled={saving()}
                                    onChange={(event) =>
                                      save({ edge_tts: { volume: event.currentTarget.value.trim() || undefined } })
                                    }
                                  />
                                </div>
                              </SettingsRowV2>

                              <SettingsRowV2
                                title={language.t("settings.plugins.tts.debug.title")}
                                description={language.t("settings.plugins.tts.debug.description")}
                              >
                                <Switch
                                  checked={tts.data?.debug === true}
                                  disabled={saving()}
                                  onChange={(value) => save({ debug: value })}
                                />
                              </SettingsRowV2>
                            </div>
                          </Match>

                          <Match when={!plugin.configurable}>
                            <div class="settings-v2-plugin-empty">{language.t("settings.plugins.detail.readonly")}</div>
                          </Match>
                        </MatchSwitch>

                        <div class="settings-v2-plugin-actions">
                          <Show
                            when={plugin.uninstallable}
                            fallback={
                              <span class="settings-v2-plugin-note">
                                {language.t("settings.plugins.uninstall.locked")}
                              </span>
                            }
                          >
                            <ButtonV2
                              size="normal"
                              variant="danger"
                              disabled={removing() === plugin.id}
                              onClick={() => remove(plugin)}
                            >
                              {language.t("settings.plugins.uninstall")}
                            </ButtonV2>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </SettingsListV2>
      </div>
    </>
  )
}
