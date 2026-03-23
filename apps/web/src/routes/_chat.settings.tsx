import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
  LOCAL_EXECUTION_TARGET_ID,
  type ExecutionTarget,
  type PortForwardProtocolHint,
  type ProviderKind,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
} from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  getAppModelOptions,
  getCustomModelsForProvider,
  getDefaultCustomModelsForProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  MODEL_PROVIDER_SETTINGS,
  patchCustomModels,
  useAppSettings,
} from "../appSettings";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { UI_SCALE_OPTIONS, type UiScale } from "../lib/uiScale";
import {
  executionTargetListQueryOptions,
  executionTargetQueryKeys,
} from "../lib/executionTargetReactQuery";
import { portForwardListQueryOptions, portForwardQueryKeys } from "../lib/portForwardReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { APP_VIEWPORT_CSS_HEIGHT } from "../lib/viewport";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { APP_VERSION } from "../branding";
import { SidebarInset, SidebarTrigger } from "~/components/ui/sidebar";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

function formatExecutionTargetConnection(target: ExecutionTarget): string {
  switch (target.connection.kind) {
    case "local":
      return "Built-in local execution target.";
    case "ssh":
      return `${target.connection.user ? `${target.connection.user}@` : ""}${target.connection.host}${target.connection.port ? `:${target.connection.port}` : ""}`;
    case "cloud":
      return target.connection.baseUrl;
  }
}
const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;
const UI_SCALE_LABELS = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "XL",
  xxl: "XXL",
} as const;

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const executionTargetQuery = useQuery(executionTargetListQueryOptions());
  const portForwardQuery = useQuery(portForwardListQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [editingExecutionTargetId, setEditingExecutionTargetId] = useState<
    ExecutionTarget["id"] | null
  >(null);
  const [executionTargetLabel, setExecutionTargetLabel] = useState("");
  const [executionTargetHost, setExecutionTargetHost] = useState("");
  const [executionTargetUser, setExecutionTargetUser] = useState("");
  const [executionTargetPort, setExecutionTargetPort] = useState("22");
  const [executionTargetPassword, setExecutionTargetPassword] = useState("");
  const [executionTargetClaudeBinaryPath, setExecutionTargetClaudeBinaryPath] = useState("");
  const [executionTargetCodexBinaryPath, setExecutionTargetCodexBinaryPath] = useState("");
  const [executionTargetCodexHomePath, setExecutionTargetCodexHomePath] = useState("");
  const executionTargetPasswordRef = useRef<HTMLInputElement | null>(null);
  const [executionTargetError, setExecutionTargetError] = useState<string | null>(null);
  const [portForwardTargetId, setPortForwardTargetId] = useState<string>(LOCAL_EXECUTION_TARGET_ID);
  const [portForwardRemotePort, setPortForwardRemotePort] = useState("");
  const [portForwardLocalPort, setPortForwardLocalPort] = useState("");
  const [portForwardLabel, setPortForwardLabel] = useState("");
  const [portForwardProtocolHint, setPortForwardProtocolHint] =
    useState<PortForwardProtocolHint>("http");
  const [portForwardError, setPortForwardError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;

  const invalidateExecutionTargets = useCallback(
    () => queryClient.invalidateQueries({ queryKey: executionTargetQueryKeys.all }),
    [queryClient],
  );
  const invalidatePortForwards = useCallback(
    () => queryClient.invalidateQueries({ queryKey: portForwardQueryKeys.all }),
    [queryClient],
  );
  const resetExecutionTargetForm = useCallback(() => {
    setEditingExecutionTargetId(null);
    setExecutionTargetLabel("");
    setExecutionTargetHost("");
    setExecutionTargetUser("");
    setExecutionTargetPort("22");
    setExecutionTargetPassword("");
    setExecutionTargetClaudeBinaryPath("");
    setExecutionTargetCodexBinaryPath("");
    setExecutionTargetCodexHomePath("");
    setExecutionTargetError(null);
  }, []);

  const upsertExecutionTargetMutation = useMutation({
    mutationFn: async () => {
      const label = executionTargetLabel.trim();
      const host = executionTargetHost.trim();
      const user = executionTargetUser.trim();
      const portValue = executionTargetPort.trim();
      const passwordValue = executionTargetPasswordRef.current?.value ?? executionTargetPassword;
      const claudeBinaryPath = executionTargetClaudeBinaryPath.trim();
      const codexBinaryPath = executionTargetCodexBinaryPath.trim();
      const codexHomePath = executionTargetCodexHomePath.trim();
      if (label.length === 0 || host.length === 0) {
        throw new Error("Label and host are required.");
      }
      const port = portValue.length === 0 ? undefined : Number(portValue);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        throw new Error("Port must be between 1 and 65535.");
      }
      const api = ensureNativeApi();
      return api.server.upsertExecutionTarget({
        ...(editingExecutionTargetId ? { id: editingExecutionTargetId } : {}),
        label,
        connection: {
          kind: "ssh",
          host,
          ...(user.length > 0 ? { user } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(passwordValue.length > 0 ? { password: passwordValue } : {}),
          ...(claudeBinaryPath.length > 0 ? { claudeBinaryPath } : {}),
          ...(codexBinaryPath.length > 0 ? { codexBinaryPath } : {}),
          ...(codexHomePath.length > 0 ? { codexHomePath } : {}),
        },
      });
    },
    onSuccess: async () => {
      resetExecutionTargetForm();
      await invalidateExecutionTargets();
    },
    onError: (error) => {
      setExecutionTargetError(
        error instanceof Error ? error.message : "Unable to save execution target.",
      );
    },
  });

  const removeExecutionTargetMutation = useMutation({
    mutationFn: async (targetId: ExecutionTarget["id"]) => {
      const api = ensureNativeApi();
      await api.server.removeExecutionTarget({ targetId });
    },
    onSuccess: async () => {
      if (editingExecutionTargetId !== null) {
        resetExecutionTargetForm();
      }
      await invalidateExecutionTargets();
    },
  });

  const checkExecutionTargetMutation = useMutation({
    mutationFn: async (targetId: ExecutionTarget["id"]) => {
      const api = ensureNativeApi();
      return api.server.checkExecutionTargetHealth({ targetId });
    },
    onSuccess: async () => {
      await invalidateExecutionTargets();
    },
  });
  const openPortForwardMutation = useMutation({
    mutationFn: async () => {
      const remotePort = Number(portForwardRemotePort.trim());
      const localPortValue = portForwardLocalPort.trim();
      const localPort = localPortValue.length > 0 ? Number(localPortValue) : undefined;
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
        throw new Error("Remote port must be between 1 and 65535.");
      }
      if (
        localPort !== undefined &&
        (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535)
      ) {
        throw new Error("Local port must be between 1 and 65535.");
      }
      const api = ensureNativeApi();
      return api.portForward.open({
        targetId: portForwardTargetId as ExecutionTarget["id"],
        remotePort,
        ...(localPort !== undefined ? { localPort } : {}),
        ...(portForwardLabel.trim().length > 0 ? { label: portForwardLabel.trim() } : {}),
        protocolHint: portForwardProtocolHint,
      });
    },
    onSuccess: async () => {
      setPortForwardRemotePort("");
      setPortForwardLocalPort("");
      setPortForwardLabel("");
      setPortForwardError(null);
      await invalidatePortForwards();
    },
    onError: (error) => {
      setPortForwardError(error instanceof Error ? error.message : "Unable to open port forward.");
    },
  });
  const closePortForwardMutation = useMutation({
    mutationFn: async (id: string) => {
      const api = ensureNativeApi();
      await api.portForward.close({ id });
    },
    onSuccess: async () => {
      await invalidatePortForwards();
    },
  });

  const gitTextGenerationModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.textGenerationModel,
  );
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.slug === (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
    )?.name ?? settings.textGenerationModel;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);
  const startEditingExecutionTarget = useCallback((target: ExecutionTarget) => {
    if (target.connection.kind !== "ssh") {
      return;
    }
    setEditingExecutionTargetId(target.id);
    setExecutionTargetLabel(target.label);
    setExecutionTargetHost(target.connection.host);
    setExecutionTargetUser(target.connection.user ?? "");
    setExecutionTargetPort(
      target.connection.port !== undefined ? String(target.connection.port) : "22",
    );
    setExecutionTargetPassword("");
    setExecutionTargetClaudeBinaryPath(target.connection.claudeBinaryPath ?? "");
    setExecutionTargetCodexBinaryPath(target.connection.codexBinaryPath ?? "");
    setExecutionTargetCodexHomePath(target.connection.codexHomePath ?? "");
    setExecutionTargetError(null);
  }, []);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset
      className="min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate"
      style={{ height: APP_VIEWPORT_CSS_HEIGHT }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="flex items-start gap-3">
              <SidebarTrigger className="size-7 shrink-0" />
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Configure app-level preferences for this device.
                </p>
              </div>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code looks across the app.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                  {THEME_OPTIONS.map((option) => {
                    const selected = theme === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          selected
                            ? "border-primary/60 bg-primary/8 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-accent"
                        }`}
                        onClick={() => setTheme(option.value)}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{option.label}</span>
                          <span className="text-xs">{option.description}</span>
                        </span>
                        {selected ? (
                          <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                <p className="text-xs text-muted-foreground">
                  Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
                </p>

                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Timestamp format</p>
                    <p className="text-xs text-muted-foreground">
                      System default follows your browser or OS time format. <code>12-hour</code>{" "}
                      and <code>24-hour</code> force the hour cycle.
                    </p>
                  </div>
                  <Select
                    value={settings.timestampFormat}
                    onValueChange={(value) => {
                      if (value !== "locale" && value !== "12-hour" && value !== "24-hour") return;
                      updateSettings({
                        timestampFormat: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-40" aria-label="Timestamp format">
                      <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      <SelectItem value="locale">{TIMESTAMP_FORMAT_LABELS.locale}</SelectItem>
                      <SelectItem value="12-hour">{TIMESTAMP_FORMAT_LABELS["12-hour"]}</SelectItem>
                      <SelectItem value="24-hour">{TIMESTAMP_FORMAT_LABELS["24-hour"]}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Font and button size</p>
                    <p className="text-xs text-muted-foreground">
                      Increases app font sizes and button sizes across the interface.
                    </p>
                  </div>
                  <Select
                    value={settings.uiScale}
                    onValueChange={(value) => {
                      if (!UI_SCALE_OPTIONS.includes(value as UiScale)) {
                        return;
                      }
                      updateSettings({
                        uiScale: value as UiScale,
                      });
                    }}
                  >
                    <SelectTrigger className="w-40" aria-label="UI size">
                      <SelectValue>{UI_SCALE_LABELS[settings.uiScale]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      <SelectItem value="small">{UI_SCALE_LABELS.small}</SelectItem>
                      <SelectItem value="medium">{UI_SCALE_LABELS.medium}</SelectItem>
                      <SelectItem value="large">{UI_SCALE_LABELS.large}</SelectItem>
                      <SelectItem value="xl">{UI_SCALE_LABELS.xl}</SelectItem>
                      <SelectItem value="xxl">{UI_SCALE_LABELS.xxl}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                {settings.timestampFormat !== defaults.timestampFormat ||
                settings.uiScale !== defaults.uiScale ? (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSettings({
                          timestampFormat: defaults.timestampFormat,
                          uiScale: defaults.uiScale,
                        })
                      }
                    >
                      Restore default
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Execution Targets</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Register remote machines for thread execution, remote Git, and provider startup.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Label</span>
                  <Input
                    value={executionTargetLabel}
                    onChange={(event) => setExecutionTargetLabel(event.target.value)}
                    placeholder="Staging Box"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Host</span>
                  <Input
                    value={executionTargetHost}
                    onChange={(event) => setExecutionTargetHost(event.target.value)}
                    placeholder="staging.example.com"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">User</span>
                  <Input
                    value={executionTargetUser}
                    onChange={(event) => setExecutionTargetUser(event.target.value)}
                    placeholder="deploy"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Port</span>
                  <Input
                    value={executionTargetPort}
                    onChange={(event) => setExecutionTargetPort(event.target.value)}
                    inputMode="numeric"
                    placeholder="22"
                  />
                </label>

                <label className="block space-y-1 md:col-span-2">
                  <span className="text-xs font-medium text-foreground">Password</span>
                  <Input
                    ref={executionTargetPasswordRef}
                    nativeInput
                    type="password"
                    autoComplete="new-password"
                    value={executionTargetPassword}
                    onChange={(event) => setExecutionTargetPassword(event.target.value)}
                    placeholder="Optional SSH password"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored in the local app database. Leave blank while editing to keep the current
                    password.
                  </p>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Remote Claude binary path
                  </span>
                  <Input
                    value={executionTargetClaudeBinaryPath}
                    onChange={(event) => setExecutionTargetClaudeBinaryPath(event.target.value)}
                    placeholder="claude"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional absolute path for Claude Code on this target.
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Remote Codex binary path
                  </span>
                  <Input
                    value={executionTargetCodexBinaryPath}
                    onChange={(event) => setExecutionTargetCodexBinaryPath(event.target.value)}
                    placeholder="Auto-detect"
                    spellCheck={false}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Optional override when the remote machine does not expose <code>codex</code> on
                    its default login PATH.
                  </p>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Remote CODEX_HOME path
                  </span>
                  <Input
                    value={executionTargetCodexHomePath}
                    onChange={(event) => setExecutionTargetCodexHomePath(event.target.value)}
                    placeholder="Optional"
                    spellCheck={false}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Optional remote Codex config directory for this target only.
                  </p>
                </label>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => {
                    setExecutionTargetError(null);
                    upsertExecutionTargetMutation.mutate();
                  }}
                  disabled={upsertExecutionTargetMutation.isPending}
                >
                  {editingExecutionTargetId ? "Save SSH Target" : "Add SSH Target"}
                </Button>
                {editingExecutionTargetId ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetExecutionTargetForm}
                    disabled={upsertExecutionTargetMutation.isPending}
                  >
                    Cancel
                  </Button>
                ) : null}
                {executionTargetError ? (
                  <p className="text-xs text-destructive">{executionTargetError}</p>
                ) : null}
              </div>

              <div className="mt-5 space-y-3">
                {(executionTargetQuery.data ?? []).map((target) => (
                  <div
                    key={target.id}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-background px-3 py-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {target.label}
                        </p>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {target.kind}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {target.health?.status ?? "unknown"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatExecutionTargetConnection(target)}
                      </p>
                      {target.health?.detail ? (
                        <p className="mt-1 text-xs text-muted-foreground">{target.health.detail}</p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => checkExecutionTargetMutation.mutate(target.id)}
                        disabled={checkExecutionTargetMutation.isPending}
                      >
                        Check Health
                      </Button>
                      {target.id !== "local" ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => startEditingExecutionTarget(target)}
                          disabled={upsertExecutionTargetMutation.isPending}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {target.id !== "local" ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => removeExecutionTargetMutation.mutate(target.id)}
                          disabled={removeExecutionTargetMutation.isPending}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Port Forwards</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open browser-facing tunnels to services running on a registered target.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Target</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={portForwardTargetId}
                    onChange={(event) => setPortForwardTargetId(event.target.value)}
                  >
                    {(executionTargetQuery.data ?? []).map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Protocol</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={portForwardProtocolHint}
                    onChange={(event) =>
                      setPortForwardProtocolHint(event.target.value as PortForwardProtocolHint)
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="tcp">TCP</option>
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Remote port</span>
                  <Input
                    value={portForwardRemotePort}
                    onChange={(event) => setPortForwardRemotePort(event.target.value)}
                    inputMode="numeric"
                    placeholder="3000"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Local port (optional)</span>
                  <Input
                    value={portForwardLocalPort}
                    onChange={(event) => setPortForwardLocalPort(event.target.value)}
                    inputMode="numeric"
                    placeholder="auto"
                  />
                </label>

                <label className="block space-y-1 md:col-span-2">
                  <span className="text-xs font-medium text-foreground">Label (optional)</span>
                  <Input
                    value={portForwardLabel}
                    onChange={(event) => setPortForwardLabel(event.target.value)}
                    placeholder="Web UI"
                  />
                </label>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => {
                    setPortForwardError(null);
                    openPortForwardMutation.mutate();
                  }}
                  disabled={openPortForwardMutation.isPending}
                >
                  Open Port Forward
                </Button>
                {portForwardError ? (
                  <p className="text-xs text-destructive">{portForwardError}</p>
                ) : null}
              </div>

              <div className="mt-5 space-y-3">
                {(portForwardQuery.data ?? []).map((forward) => (
                  <div
                    key={forward.id}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-background px-3 py-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {forward.label ?? `${forward.targetId}:${forward.remotePort}`}
                        </p>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {forward.status}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {forward.protocolHint ?? "tcp"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {forward.targetId} · 127.0.0.1:{forward.localPort} → {forward.remoteHost}:
                        {forward.remotePort}
                      </p>
                      {forward.url ? (
                        <p className="mt-1 text-xs text-muted-foreground">{forward.url}</p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {forward.url ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (!forward.url) return;
                            const api = ensureNativeApi();
                            void api.shell.openExternal(forward.url);
                          }}
                        >
                          Open
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => closePortForwardMutation.mutate(forward.id)}
                        disabled={closePortForwardMutation.isPending}
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p>Binary source</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {codexBinaryPath || "PATH"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                    {slug}
                                  </code>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Git</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure the model used for generating commit messages, PR titles, and branch
                  names.
                </p>
              </div>

              <div className="flex flex-col gap-4 rounded-lg border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Text generation model</p>
                  <p className="text-xs text-muted-foreground">
                    Model used for auto-generated git content.
                  </p>
                </div>
                <Select
                  value={settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL}
                  onValueChange={(value) => {
                    if (value) {
                      updateSettings({
                        textGenerationModel: value,
                      });
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full shrink-0 sm:w-48"
                    aria-label="Git text generation model"
                  >
                    <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {gitTextGenerationModelOptions.map((option) => (
                      <SelectItem key={option.slug} value={option.slug}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              {settings.textGenerationModel !== defaults.textGenerationModel ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        textGenerationModel: defaults.textGenerationModel,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Threads</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the default workspace mode for newly created draft threads.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Default to New worktree</p>
                  <p className="text-xs text-muted-foreground">
                    New threads start in New worktree mode instead of Local.
                  </p>
                </div>
                <Switch
                  checked={settings.defaultThreadEnvMode === "worktree"}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      defaultThreadEnvMode: checked ? "worktree" : "local",
                    })
                  }
                  aria-label="Default new threads to New worktree mode"
                />
              </div>

              {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">About</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Application version and environment information.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Version</p>
                  <p className="text-xs text-muted-foreground">
                    Current version of the application.
                  </p>
                </div>
                <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
