import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { SessionTreeSnapshot } from "@bimanus/session-driver/types";
import type { RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import {
  DEFAULT_SIDEBAR_WIDTH,
  getSelectedSession,
  getSelectedWorkspace,
  resolveLocale,
  type AppView,
  type DesktopAppState,
  type LocaleSetting,
  type McpServerConfigInput,
  type NewThreadEnvironment,
  type WorkspaceRecord,
  type WorkspaceSessionTarget,
} from "./desktop-state";
import { I18nProvider, translate, useI18n } from "./i18n";
import { DiffPanel, type DiffPanelFileRequest } from "./diff-panel";
import { SystemPromptPanel } from "./system-prompt-panel";
import { buildModelOptions } from "./composer-commands";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  getDesktopShortcutLabel,
  type DesktopNotificationPermissionStatus,
  type OpenCodingCliEvent,
  type PiDesktopCommand,
  type SplitPanelCliType,
  type TerminalLaunchConfig,
  type TerminalSessionSnapshot,
} from "./ipc";
import { deriveModelOnboardingState } from "./model-onboarding";
import { SkillsView } from "./skills-view";
import { ExtensionsView } from "./extensions-view";
import { SettingsView, type SettingsSection } from "./settings-view";
import { SecondarySurface } from "./secondary-surface";
import { buildThreadGroups } from "./thread-groups";
import { Sidebar } from "./sidebar";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { Topbar, HeaderActions } from "./topbar";
import { TerminalPanel } from "./terminal-panel";
import { SplitPanel } from "./split-panel/split-panel";
import { useMobileBreakpoint } from "./use-mobile-breakpoint";
import { useThreadSearch } from "./hooks/use-thread-search";
import {
  createExistingTuiSessionKey,
  findWorkspaceById,
  formatTuiTabLimitError,
  getTuiTabTarget,
  hasTuiTabForTarget,
  isNewTuiSessionKey,
  piTuiTerminalScopeId,
  parseExistingTuiSessionKey,
  useTuiTabs,
} from "./hooks/use-tui-tabs";
import { createTuiPerfTraceId, logTuiPerf } from "./tui-perf-log";
import { useWorkspaceMenu } from "./hooks/use-workspace-menu";
import { buildExtensionDockModel, ExtensionDialog, hasExtensionDockContent } from "./extension-session-ui";
import { TreeModal } from "./tree-modal";
import { getEffectiveModelRuntime } from "./model-settings";
import { resolveRepoWorkspaceId } from "./workspace-roots";
import { deriveWorkspaceContext } from "./workspace-context";
import { useSplitPanelTabs } from "./hooks/use-split-panel-tabs";
import { authorizeRemoteUi, RemoteUiUnauthorizedError } from "./remote-client";

const VIRTUALIZATION_THRESHOLD = Number.POSITIVE_INFINITY;

function isSessionRunning(workspaces: readonly WorkspaceRecord[], target: WorkspaceSessionTarget): boolean {
  return findWorkspaceById(workspaces, target.workspaceId)?.sessions.some(
    (session) => session.id === target.sessionId && session.status === "running",
  ) ?? false;
}

function setSessionKeyFlag(
  current: Readonly<Record<string, boolean>>,
  sessionKey: string,
): Readonly<Record<string, boolean>> {
  if (current[sessionKey]) {
    return current;
  }
  return { ...current, [sessionKey]: true };
}

function clearSessionKeyFlag(
  current: Readonly<Record<string, boolean>>,
  sessionKey: string,
): Readonly<Record<string, boolean>> {
  if (!current[sessionKey]) {
    return current;
  }
  const next = { ...current };
  delete next[sessionKey];
  return next;
}

function isSplitPanelCliType(value: string): value is SplitPanelCliType {
  return [
    "codex",
    "claude",
    "opencode",
    "grok",
    "copilot",
    "antigravity",
    "kiro",
    "cursor",
    "droid",
  ].includes(value);
}

function pruneSessionKeyFlags(
  current: Readonly<Record<string, boolean>>,
  validSessionKeys: Set<string>,
): Readonly<Record<string, boolean>> {
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [sessionKey, enabled] of Object.entries(current)) {
    if (enabled && validSessionKeys.has(sessionKey)) {
      next[sessionKey] = true;
    } else if (enabled) {
      changed = true;
    }
  }
  return changed ? next : current;
}

function getTuiTabKeyForTerminalSession(session: TerminalSessionSnapshot): string | undefined {
  if (session.launchConfig.mode !== "pi-tui") {
    return undefined;
  }
  if (session.launchConfig.sessionId) {
    return createExistingTuiSessionKey({
      workspaceId: session.workspaceId,
      sessionId: session.launchConfig.sessionId,
    });
  }
  return session.launchConfig.newSessionKey?.trim() || undefined;
}

function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [authorizationRequired, setAuthorizationRequired] = useState(false);

  useEffect(() => {
    let active = true;
    let retryTimeoutId: number | undefined;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    const hydrate = async (retryDelayMs = 250): Promise<void> => {
      try {
        const state = await api.getState();
        if (!active) {
          return;
        }
        setSnapshot(state);
      } catch (error) {
        if (!active) {
          return;
        }
        if (error instanceof RemoteUiUnauthorizedError) {
          setAuthorizationRequired(true);
          return;
        }
        // The dev renderer can come up before the Electron remote bridge.
        retryTimeoutId = window.setTimeout(() => {
          void hydrate(Math.min(retryDelayMs * 2, 2_000));
        }, retryDelayMs);
      }
    };

    void hydrate();

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        setSnapshot(state);
      }
    });

    return () => {
      active = false;
      if (retryTimeoutId !== undefined) {
        window.clearTimeout(retryTimeoutId);
      }
      unsubscribeState();
    };
  }, []);

  return [snapshot, setSnapshot, authorizationRequired] as const;
}

function RemoteUiLogin() {
  const [password, setPassword] = useState("");
  const { t } = useI18n();

  return (
    <div className="extension-dialog-backdrop">
      <form
        className="extension-dialog"
        data-testid="remote-ui-login"
        onSubmit={(event) => {
          event.preventDefault();
          if (password.trim()) authorizeRemoteUi(password);
        }}
      >
        <div className="extension-dialog__title">{t("app.remoteAccess.title")}</div>
        <p className="extension-dialog__body">{t("app.remoteAccess.body")}</p>
        <input
          autoFocus
          aria-label={t("app.remoteAccess.ariaLabel")}
          className="settings-text-input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="extension-dialog__actions">
          <button className="button button--primary" disabled={!password.trim()} type="submit">{t("app.remoteAccess.login")}</button>
        </div>
      </form>
    </div>
  );
}

function updateSnapshot(
  api: NonNullable<typeof window.piApp>,
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
) {
  return action().then((state) => {
    setSnapshot(state);
    return state;
  });
}

function isEventInsideTerminal(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("[data-pi-terminal]"));
}

function canTogglePrimarySidebar(view: AppView | undefined): boolean {
  return view === "threads" || view === "new-thread";
}

function useRunningLabel(
  startedAt: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const [label, setLabel] = useState(() => formatRunningLabel(startedAt, t));

  useEffect(() => {
    setLabel(formatRunningLabel(startedAt, t));
    if (!startedAt) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setLabel(formatRunningLabel(startedAt, t));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt, t]);

  return label;
}

function formatRunningLabel(
  startedAt: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!startedAt) {
    return t("app.working");
  }

  const diffMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.max(1, Math.floor(diffMs / 1000));
  if (seconds < 60) {
    return t("app.workingSeconds", { seconds });
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0
    ? t("app.workingMinutes", { minutes })
    : t("app.workingMinutesSeconds", { minutes, remaining });
}

export default function App() {
  const isMobile = useMobileBreakpoint();
  const [snapshot, setSnapshot, authorizationRequired] = useDesktopAppState();
  const resolvedLocale = snapshot ? resolveLocale(snapshot.locale) : resolveLocale("auto");
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(resolvedLocale, key, params),
    [resolvedLocale],
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  const [pendingNewThreadWorkspaceId, setPendingNewThreadWorkspaceId] = useState("");
  const [newThreadRootWorkspaceId, setNewThreadRootWorkspaceId] = useState("");
  const [newThreadEnvironment, setNewThreadEnvironment] = useState<NewThreadEnvironment>("local");
  const [newThreadPrompt, setNewThreadPrompt] = useState("");
  const [newThreadProvider, setNewThreadProvider] = useState<string | undefined>();
  const [newThreadModelId, setNewThreadModelId] = useState<string | undefined>();
  const [newThreadThinkingLevel, setNewThreadThinkingLevel] = useState<string | undefined>();
  const [newThreadComposerError, setNewThreadComposerError] = useState<string | undefined>();
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">("system");
  const [notificationPermissionStatus, setNotificationPermissionStatus] =
    useState<DesktopNotificationPermissionStatus>("unknown");
  const [notificationPermissionPending, setNotificationPermissionPending] = useState(false);
  const [dockExpandedBySession, setDockExpandedBySession] = useState<Record<string, boolean>>({});
  const [treeModalState, setTreeModalState] = useState<{
    readonly open: boolean;
    readonly loading: boolean;
    readonly submitting: boolean;
    readonly tree?: SessionTreeSnapshot;
    readonly error?: string;
  }>({
    open: false,
    loading: false,
    submitting: false,
  });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const newThreadComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const lastTranscriptMarkerRef = useRef("");
  const pinnedToBottomRef = useRef(true);
  const previousTimelinePaneSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastTimelineScrollTopBySessionRef = useRef(new Map<string, number>());
  const lastTimelinePinnedBySessionRef = useRef(new Map<string, boolean>());
  const preserveBottomOnNextPaneResizeRef = useRef(false);
  const exactBottomRestoreSessionKeyRef = useRef<string | null>(null);
  const deferredPinnedBottomAlignmentRef = useRef(false);
  const pendingPinnedBottomBehaviorRef = useRef<ScrollBehavior>("auto");
  const previousActiveViewRef = useRef<AppView | null>(null);
  const didAutoOpenTuiRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const [showSystemPromptPanel, setShowSystemPromptPanel] = useState(false);
  const [openTerminalSessionKeys, setOpenTerminalSessionKeys] = useState<Readonly<Record<string, boolean>>>({});
  const [takeoverTerminalSessionKeys, setTakeoverTerminalSessionKeys] = useState<Readonly<Record<string, boolean>>>({});
  const [splitPanelWorkspaceKeys, setSplitPanelWorkspaceKeys] = useState<Readonly<Record<string, boolean>>>({});
  const [pendingOpenCodingCli, setPendingOpenCodingCli] = useState<OpenCodingCliEvent | null>(null);
  const tuiTabs = useTuiTabs(snapshot?.tuiTabLimit);
  const [tuiReattachEpoch, setTuiReattachEpoch] = useState(0);
  const tuiPerfTraceBySessionKeyRef = useRef(new Map<string, string>());
  const [terminalHeight, setTerminalHeight] = useState(340);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const sidebarWidthInitializedRef = useRef(false);
  const [diffFileRequest, setDiffFileRequest] = useState<DiffPanelFileRequest | null>(null);
  const [timelinePaneMountVersion, setTimelinePaneMountVersion] = useState(0);
  const [disableTimelineVirtualization, setDisableTimelineVirtualization] = useState(true);
  const threadSearch = useThreadSearch(timelinePaneRef);
  const api = window.piApp;
  const getTuiPerfTraceId = useCallback((workspaceId: string | undefined, sessionId: string | undefined) => {
    const key = `${workspaceId || "unknown"}:${sessionId || "new"}`;
    const existing = tuiPerfTraceBySessionKeyRef.current.get(key);
    if (existing) {
      return existing;
    }
    const traceId = createTuiPerfTraceId(workspaceId, sessionId);
    tuiPerfTraceBySessionKeyRef.current.set(key, traceId);
    return traceId;
  }, []);
  const sidebarToggleStateRef = useRef<{
    readonly api: typeof window.piApp;
    readonly activeView: AppView | undefined;
    readonly sidebarCollapsed: boolean;
  }>({
    api,
    activeView: undefined,
    sidebarCollapsed: false,
  });
  sidebarToggleStateRef.current = {
    api,
    activeView: snapshot?.activeView,
    sidebarCollapsed: snapshot?.sidebarCollapsed ?? false,
  };

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi) return;

    document.documentElement.classList.add(`platform-${piApi.platform}`);

    void piApi.getResolvedTheme().then((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    void piApi.getThemeMode().then((mode) => {
      setThemeMode(mode);
    });

    const unsub = piApi.onThemeChanged((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    return unsub;
  }, []);

  useEffect(() => {
    if (snapshot) {
      document.documentElement.classList.toggle("enable-transparency", snapshot.enableTransparency);
    }
  }, [snapshot?.enableTransparency]);

  useEffect(() => {
    if (!snapshot || sidebarWidthInitializedRef.current) {
      return;
    }
    sidebarWidthInitializedRef.current = true;
    setSidebarWidth(snapshot.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
  }, [snapshot?.sidebarWidth]);

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi?.onNotificationPermissionStatusChanged) {
      return;
    }

    return piApi.onNotificationPermissionStatusChanged((status) => {
      setNotificationPermissionStatus(status);
    });
  }, []);

  const refreshNotificationPermissionStatus = useCallback(() => {
    if (!api?.getNotificationPermissionStatus) {
      return Promise.resolve("unknown" as DesktopNotificationPermissionStatus);
    }

    return api.getNotificationPermissionStatus().then((status) => {
      setNotificationPermissionStatus(status);
      return status;
    });
  }, [api]);

  useEffect(() => {
    if (snapshot?.activeView !== "settings" || settingsSection !== "notifications") {
      return undefined;
    }

    void refreshNotificationPermissionStatus();
    return undefined;
  }, [refreshNotificationPermissionStatus, settingsSection, snapshot?.activeView]);

  const {
    activeWorktrees,
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    selectedWorkspace,
    visibleWorkspaces,
  } = useMemo(() => deriveWorkspaceContext(snapshot), [snapshot]);
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const selectedRuntime = selectedWorkspace ? snapshot?.runtimeByWorkspace[selectedWorkspace.id] : undefined;
  const selectedModelRuntime = snapshot ? getEffectiveModelRuntime(snapshot, selectedWorkspace) : undefined;
  const selectedWorktree = selectedWorkspace ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id) : undefined;
  const settingsWorkspace =
    (settingsWorkspaceId ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId) : undefined) ??
    rootWorkspace ??
    rootWorkspaceOptions[0];
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const extensionsWorkspace = extensionsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === extensionsWorkspaceId)
    : undefined;
  const settingsRuntime = settingsWorkspace ? snapshot?.runtimeByWorkspace[settingsWorkspace.id] : undefined;
  const globalSettingsRuntime = snapshot ? getEffectiveModelRuntime(snapshot, undefined) : undefined;
  const settingsViewWorkspace = settingsSection === "models" || settingsSection === "providers" ? undefined : settingsWorkspace;
  const skillsRuntime = skillsWorkspace ? snapshot?.runtimeByWorkspace[skillsWorkspace.id] : undefined;
  const extensionsRuntime = extensionsWorkspace ? snapshot?.runtimeByWorkspace[extensionsWorkspace.id] : undefined;
  const extensionsCommandCompatibility = extensionsWorkspace
    ? snapshot?.extensionCommandCompatibilityByWorkspace[extensionsWorkspace.id] ?? []
    : [];
  const newThreadWorkspace =
    rootWorkspaceOptions.find((entry) => entry.id === newThreadRootWorkspaceId) ?? rootWorkspaceOptions[0];
  const newThreadRuntime = snapshot ? getEffectiveModelRuntime(snapshot, newThreadWorkspace) : undefined;
  const newThreadDefaultEnabled = buildModelOptions(newThreadRuntime).some(
    (m) => m.providerId === newThreadRuntime?.settings.defaultProvider && m.modelId === newThreadRuntime?.settings.defaultModelId,
  );
  const selectedDefaultEnabled = buildModelOptions(selectedModelRuntime).some(
    (m) => m.providerId === selectedModelRuntime?.settings.defaultProvider && m.modelId === selectedModelRuntime?.settings.defaultModelId,
  );
  const resolvedSessionProvider =
    selectedSession?.config?.provider ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultProvider : undefined);
  const resolvedSessionModelId =
    selectedSession?.config?.modelId ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultModelId : undefined);
  const resolvedSessionThinkingLevel =
    selectedSession?.config?.thinkingLevel ?? selectedModelRuntime?.settings.defaultThinkingLevel;
  const resolvedNewThreadProvider = newThreadProvider ?? (newThreadDefaultEnabled ? newThreadRuntime?.settings.defaultProvider : undefined);
  const resolvedNewThreadModelId = newThreadModelId ?? (newThreadDefaultEnabled ? newThreadRuntime?.settings.defaultModelId : undefined);
  const resolvedNewThreadThinkingLevel = newThreadThinkingLevel ?? newThreadRuntime?.settings.defaultThinkingLevel;
  const selectedSessionModelOnboarding = deriveModelOnboardingState(selectedModelRuntime, {
    provider: resolvedSessionProvider,
    modelId: resolvedSessionModelId,
  });
  const newThreadModelOnboarding = deriveModelOnboardingState(newThreadRuntime, {
    provider: resolvedNewThreadProvider,
    modelId: resolvedNewThreadModelId,
  });
  const runningLabel = useRunningLabel(selectedSession?.status === "running" ? selectedSession.runningSince : undefined, t);
  const selectedSessionKey = selectedWorkspace && selectedSession ? `${selectedWorkspace.id}:${selectedSession.id}` : "";
  const activeTuiTab = tuiTabs.visibleTab;
  const openNewTuiWorkspaceId = activeTuiTab?.kind === "new" ? activeTuiTab.workspaceId : undefined;
  const openExistingTuiTarget = getTuiTabTarget(activeTuiTab);
  const openNewTuiWorkspace = openNewTuiWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === openNewTuiWorkspaceId)
    : undefined;
  const openExistingTuiWorkspace = openExistingTuiTarget
    ? findWorkspaceById(snapshot?.workspaces ?? [], openExistingTuiTarget.workspaceId)
    : undefined;
  // Do not fall back to selectedWorkspace for existing TUI sessions. During a
  // cross-project sidebar click the selected snapshot can still point at the
  // previous project for one render; falling back there mixes the target
  // sessionId from project A with the terminal root from project B and causes
  // the renderer to attach to the wrong PTY stream.
  const tuiWorkspace = openNewTuiWorkspace ?? openExistingTuiWorkspace;
  const tuiSessionId = openExistingTuiTarget?.sessionId;
  const tuiWorkspaceId = openExistingTuiTarget?.workspaceId ?? openNewTuiWorkspaceId;

  const splitPanelWorkspaceId = tuiWorkspaceId ?? selectedWorkspace?.id ?? "";
  const splitPanelTabs = useSplitPanelTabs(splitPanelWorkspaceId);
  const showSplitPanel = Boolean(splitPanelWorkspaceId && splitPanelWorkspaceKeys[splitPanelWorkspaceId]);
  const { prune: pruneSplitPanelTabs } = splitPanelTabs;

  const isThreadsView = snapshot?.activeView === "threads";
  const isTerminalVisibleForSelectedThread =
    isThreadsView && Boolean(selectedSessionKey) && Boolean(openTerminalSessionKeys[selectedSessionKey]);
  const isTerminalTakeoverForSelectedThread =
    isThreadsView && Boolean(selectedSessionKey) && Boolean(takeoverTerminalSessionKeys[selectedSessionKey]);

  const tuiPerfTraceId = useMemo(
    () => (activeTuiTab ? getTuiPerfTraceId(tuiWorkspaceId, tuiSessionId) : undefined),
    [activeTuiTab, getTuiPerfTraceId, tuiSessionId, tuiWorkspaceId],
  );
  const tuiTerminalScopeId = tuiWorkspaceId ? piTuiTerminalScopeId(tuiWorkspaceId) : "";
  const tuiLaunchConfig = useMemo<TerminalLaunchConfig | undefined>(
    () => {
      if (!activeTuiTab) {
        return undefined;
      }
      if (activeTuiTab.kind === "new") {
        return {
          mode: "pi-tui",
          newSessionKey: activeTuiTab.key,
          newSessionId: activeTuiTab.newSessionId,
          debugTraceId: tuiPerfTraceId,
        };
      }
      return tuiSessionId ? { mode: "pi-tui", sessionId: tuiSessionId, debugTraceId: tuiPerfTraceId } : undefined;
    },
    [activeTuiTab, tuiPerfTraceId, tuiSessionId],
  );
  const activeTranscript: readonly unknown[] = [];
  const isTranscriptLoading = false;
  const selectedSessionCommands = selectedSession ? snapshot?.sessionCommandsBySession[selectedSessionKey] ?? [] : [];
  const selectedExtensionUi = selectedSession ? snapshot?.sessionExtensionUiBySession[selectedSessionKey] : undefined;
  const selectedWorkspaceCommandCompatibility = selectedWorkspace
    ? snapshot?.extensionCommandCompatibilityByWorkspace[selectedWorkspace.id] ?? []
    : [];
  useEffect(() => {
    if (snapshot && snapshot.workspaces.length === 0) {
      setOpenTerminalSessionKeys({});
      setTakeoverTerminalSessionKeys({});
      tuiTabs.prune(() => false);
    }
  }, [snapshot, tuiTabs]);
  useEffect(() => {
    if (!snapshot) {
      return;
    }
    const validSessionKeys = new Set(
      snapshot.workspaces.flatMap((workspace) => workspace.sessions.map((session) => `${workspace.id}:${session.id}`)),
    );
    const validWorkspaceIds = new Set(snapshot.workspaces.map((w) => w.id));
    setOpenTerminalSessionKeys((current) => pruneSessionKeyFlags(current, validSessionKeys));
    setTakeoverTerminalSessionKeys((current) => pruneSessionKeyFlags(current, validSessionKeys));
    setSplitPanelWorkspaceKeys((current) => pruneSessionKeyFlags(current, validWorkspaceIds));
    pruneSplitPanelTabs(validWorkspaceIds);
  }, [snapshot, pruneSplitPanelTabs]);
  const selectedExtensionDock = useMemo(() => buildExtensionDockModel(selectedExtensionUi), [selectedExtensionUi]);
  const displayedSessionTitle = selectedExtensionUi?.title ?? selectedSession?.title ?? "";
  const activeExtensionDialog = selectedExtensionUi?.pendingDialogs[0];
  const isSelectedExtensionDockExpanded = dockExpandedBySession[selectedSessionKey] ?? false;

  const threadGroups = useMemo(
    () => (snapshot ? buildThreadGroups(snapshot) : []),
    [snapshot?.workspaces, snapshot?.worktreesByWorkspace, snapshot?.workspaceOrder],
  );
  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };
  const toggleTerminal = useCallback(() => {
    if (!selectedSessionKey) {
      return;
    }
    if (openTerminalSessionKeys[selectedSessionKey]) {
      setOpenTerminalSessionKeys((current) => clearSessionKeyFlag(current, selectedSessionKey));
      setTakeoverTerminalSessionKeys((current) => clearSessionKeyFlag(current, selectedSessionKey));
      return;
    }
    setOpenTerminalSessionKeys((current) => setSessionKeyFlag(current, selectedSessionKey));
  }, [openTerminalSessionKeys, selectedSessionKey]);
  const reloadSessionKeyFromDisk = useCallback(async (sessionKey: string) => {
    if (!api) {
      return;
    }
    const target = parseExistingTuiSessionKey(sessionKey);
    if (!target) {
      return;
    }
    await updateSnapshot(api, setSnapshot, () => api.reloadSession(target));
  }, [api]);

  const showTuiLimitError = useCallback(() => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            lastError: formatTuiTabLimitError(snapshot?.tuiTabLimit ?? 20),
          }
        : current,
    );
  }, [snapshot?.tuiTabLimit]);

  const reloadClosedTuiSessionKey = useCallback((sessionKey: string) => {
    const reloadAfterClose = isNewTuiSessionKey(sessionKey) && api
      ? updateSnapshot(api, setSnapshot, () => api.syncCurrentWorkspace()).then(() => undefined)
      : reloadSessionKeyFromDisk(sessionKey);
    void reloadAfterClose?.catch((error) => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              lastError: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    });
  }, [api, reloadSessionKeyFromDisk]);

  const hideTuiMode = useCallback(() => {
    const closedSessionKey = tuiTabs.hide();
    if (closedSessionKey && isNewTuiSessionKey(closedSessionKey)) {
      reloadClosedTuiSessionKey(closedSessionKey);
    }
    focusComposer();
  }, [reloadClosedTuiSessionKey, tuiTabs]);

  const closeTuiMode = useCallback((sessionKey = tuiTabs.activeKeyRef.current, nextActiveKey?: string) => {
    if (!sessionKey) {
      hideTuiMode();
      return;
    }
    const closedTab = tuiTabs.close(sessionKey, nextActiveKey);
    if (closedTab) {
      reloadClosedTuiSessionKey(closedTab.key);
    }
    focusComposer();
  }, [hideTuiMode, reloadClosedTuiSessionKey, tuiTabs]);

  useEffect(() => {
    const workspaces = snapshot?.workspaces ?? [];
    tuiTabs.materializeNewTabs(workspaces);
    tuiTabs.prune((tab) =>
      Boolean(findWorkspaceById(workspaces, tab.workspaceId))
    );
  }, [snapshot?.workspaces, tuiTabs]);

  const autoOpenTui = useCallback(() => {
    const currentSnapshot = snapshot;
    if (!currentSnapshot) {
      return false;
    }

    const workspaceId =
      currentSnapshot.activeView === "new-thread"
        ? newThreadWorkspace?.id ?? selectedWorkspace?.id ?? rootWorkspace?.id ?? visibleWorkspaces[0]?.id
        : selectedWorkspace?.id ?? rootWorkspace?.id ?? visibleWorkspaces[0]?.id;

    if (currentSnapshot.activeView === "new-thread") {
      if (!workspaceId) {
        return false;
      }
      const res = tuiTabs.openNew(workspaceId);
      res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      return res.success;
    }

    if (selectedSessionKey && selectedWorkspace && selectedSession) {
      const res = tuiTabs.openExisting({
        workspaceId: selectedWorkspace.id,
        sessionId: selectedSession.id,
      });
      res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      return res.success;
    }

    if (!workspaceId) {
      return false;
    }

    const res = tuiTabs.openNew(workspaceId);
    res.evictedKeys.forEach(reloadClosedTuiSessionKey);
    return res.success;
  }, [
    newThreadWorkspace?.id,
    rootWorkspace?.id,
    selectedSession,
    selectedSessionKey,
    selectedWorkspace?.id,
    snapshot?.activeView,
    tuiTabs,
    visibleWorkspaces,
    reloadClosedTuiSessionKey,
  ]);

  useEffect(() => {
    if (!snapshot || didAutoOpenTuiRef.current) {
      return;
    }

    if (autoOpenTui()) {
      didAutoOpenTuiRef.current = true;
    }
  }, [autoOpenTui, snapshot]);

  const toggleTuiMode = useCallback(() => {
    if (tuiTabs.visible) {
      hideTuiMode();
      return;
    }

    if (snapshot?.activeView === "new-thread") {
      if (!newThreadWorkspace) {
        return;
      }
      const traceId = getTuiPerfTraceId(newThreadWorkspace.id, undefined);
      logTuiPerf("renderer.tui.open-new.click", {
        workspaceId: newThreadWorkspace.id,
        traceId,
      }, {
        previousOpenTuiSessionKey: tuiTabs.activeKeyRef.current,
      });
      const res = tuiTabs.openNew(newThreadWorkspace.id);
      if (!res.success) {
        showTuiLimitError();
      } else {
        res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      }
      return;
    }

    if (!selectedSessionKey || !selectedWorkspace || !selectedSession || snapshot?.activeView !== "threads") {
      return;
    }
    const selectedTuiTarget: WorkspaceSessionTarget = {
      workspaceId: selectedWorkspace.id,
      sessionId: selectedSession.id,
    };
    if (selectedSession.status === "running") {
      // TUI is the only chat surface now; let the terminal own the conflict handling.
    }
    const nextTuiKey = createExistingTuiSessionKey(selectedTuiTarget);
    const traceId = getTuiPerfTraceId(selectedTuiTarget.workspaceId, selectedTuiTarget.sessionId);
    logTuiPerf("renderer.tui.open-existing.click", {
      workspaceId: selectedTuiTarget.workspaceId,
      sessionId: selectedTuiTarget.sessionId,
      traceId,
    }, {
      selectedSessionKey,
      nextTuiKey,
      previousOpenTuiSessionKey: tuiTabs.activeKeyRef.current,
    });
    const res = tuiTabs.openExisting(selectedTuiTarget);
    if (!res.success) {
      showTuiLimitError();
    } else {
      res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      setTuiReattachEpoch((epoch) => epoch + 1);
    }
  }, [
    getTuiPerfTraceId,
    hideTuiMode,
    newThreadWorkspace,
    selectedSession,
    selectedSessionKey,
    selectedWorkspace,
    showTuiLimitError,
    snapshot?.activeView,
    tuiTabs,
    reloadClosedTuiSessionKey,
  ]);
  const focusNewThreadComposer = () => {
    window.requestAnimationFrame(() => {
      newThreadComposerRef.current?.focus();
    });
  };
  const resetExactBottomRestoreState = (nextSessionKey: string | null = null) => {
    exactBottomRestoreSessionKeyRef.current = nextSessionKey;
    deferredPinnedBottomAlignmentRef.current = false;
    pendingPinnedBottomBehaviorRef.current = "auto";
  };
  const updateNewThreadPrompt = useCallback((value: SetStateAction<string>) => {
    setNewThreadComposerError(undefined);
    setNewThreadPrompt(value);
  }, []);
  const scrollTimelineToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    const align = (remainingChecks: number) => {
      if (behavior === "auto") {
        pane.scrollTop = pane.scrollHeight;
      } else {
        pane.scrollTo({ top: pane.scrollHeight, behavior });
      }
      pinnedToBottomRef.current = true;
      lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
      lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, true);
      setShowJumpToLatest(false);

      if (remainingChecks <= 0) {
        return;
      }

      window.requestAnimationFrame(() => {
        const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        if (remaining > 1 || remainingChecks > 1) {
          align(remainingChecks - 1);
        }
      });
    };

    align(6);
  }, [selectedSessionKey]);

  const requestPinnedBottomAlignment = useCallback((
    behavior: ScrollBehavior = "auto",
    options?: { readonly preferExactRestore?: boolean },
  ) => {
    if (exactBottomRestoreSessionKeyRef.current === selectedSessionKey && selectedSessionKey) {
      pendingPinnedBottomBehaviorRef.current = behavior;
      deferredPinnedBottomAlignmentRef.current = true;
      return;
    }

    if (options?.preferExactRestore && selectedSessionKey && activeTranscript.length > VIRTUALIZATION_THRESHOLD) {
      exactBottomRestoreSessionKeyRef.current = selectedSessionKey;
      pendingPinnedBottomBehaviorRef.current = behavior;
      preserveBottomOnNextPaneResizeRef.current = true;
      setDisableTimelineVirtualization(true);
      return;
    }

    scrollTimelineToBottom(behavior);
  }, [activeTranscript.length, scrollTimelineToBottom, selectedSessionKey]);

  const finalizeTimelineVirtualizationDisable = useCallback(() => {
    const pane = timelinePaneRef.current;
    const restoreSessionKey = exactBottomRestoreSessionKeyRef.current;
    if (!pane || snapshot?.activeView !== "threads") {
      resetExactBottomRestoreState();
      setDisableTimelineVirtualization(false);
      return;
    }

    if (restoreSessionKey !== selectedSessionKey || !restoreSessionKey) {
      setDisableTimelineVirtualization(false);
      return;
    }

    const shouldRestoreBottom =
      pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current || deferredPinnedBottomAlignmentRef.current;
    if (!shouldRestoreBottom) {
      resetExactBottomRestoreState();
      setDisableTimelineVirtualization(false);
      return;
    }

    const finishRestore = (remainingChecks: number, stableChecks: number) => {
      window.requestAnimationFrame(() => {
        if (timelinePaneRef.current !== pane || exactBottomRestoreSessionKeyRef.current !== restoreSessionKey) {
          return;
        }

        if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
          scrollTimelineToBottom();
        }

        const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        const nextStableChecks = remaining <= 16 ? stableChecks + 1 : 0;
        if (remainingChecks <= 1 || nextStableChecks >= 2) {
          const shouldApplyDeferredAlignment = deferredPinnedBottomAlignmentRef.current;
          resetExactBottomRestoreState();
          if (shouldApplyDeferredAlignment) {
            scrollTimelineToBottom();
          }
          preserveBottomOnNextPaneResizeRef.current = false;
          return;
        }

        finishRestore(remainingChecks - 1, nextStableChecks);
      });
    };

    if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
      scrollTimelineToBottom();
    }

    window.requestAnimationFrame(() => {
      if (timelinePaneRef.current !== pane || exactBottomRestoreSessionKeyRef.current !== restoreSessionKey) {
        return;
      }
      setDisableTimelineVirtualization(false);
      scrollTimelineToBottom(pendingPinnedBottomBehaviorRef.current);
      pendingPinnedBottomBehaviorRef.current = "auto";
      finishRestore(6, 0);
    });
  }, [scrollTimelineToBottom, selectedSessionKey, snapshot?.activeView]);

  const setTimelinePaneElement = useCallback((node: HTMLDivElement | null) => {
    timelinePaneRef.current = node;
    if (!node) {
      return;
    }

    setTimelinePaneMountVersion((current) => current + 1);

    const savedPinned = lastTimelinePinnedBySessionRef.current.get(selectedSessionKey);
    const savedScrollTop = lastTimelineScrollTopBySessionRef.current.get(selectedSessionKey);

    if (!selectedSessionKey || snapshot?.activeView !== "threads") {
      setDisableTimelineVirtualization(false);
      return;
    }

    const shouldRestoreBottom = (savedPinned ?? pinnedToBottomRef.current) || preserveBottomOnNextPaneResizeRef.current;
    if (shouldRestoreBottom) {
      preserveBottomOnNextPaneResizeRef.current = true;
      node.scrollTop = node.scrollHeight;
      window.requestAnimationFrame(() => {
        if (timelinePaneRef.current !== node) {
          return;
        }
        if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
          requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        }
      });
      return;
    }

    if (savedScrollTop == null) {
      setDisableTimelineVirtualization(false);
      return;
    }

    node.scrollTop = savedScrollTop;
    pinnedToBottomRef.current = false;
    resetExactBottomRestoreState();
    lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, false);
    window.requestAnimationFrame(() => {
      if (timelinePaneRef.current !== node) {
        return;
      }
      setDisableTimelineVirtualization(false);
    });
  }, [scrollTimelineToBottom, selectedSessionKey, snapshot?.activeView]);

  const schedulePinnedBottomRealignment = useCallback((delayFrames = 0) => {
    const waitForFrames = (remainingFrames: number) => {
      window.requestAnimationFrame(() => {
        if (remainingFrames > 0) {
          waitForFrames(remainingFrames - 1);
          return;
        }
        requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        window.requestAnimationFrame(() => {
          preserveBottomOnNextPaneResizeRef.current = false;
          if (pinnedToBottomRef.current) {
            requestPinnedBottomAlignment("auto", { preferExactRestore: true });
          }
        });
      });
    };

    waitForFrames(delayFrames);
  }, [requestPinnedBottomAlignment]);

  const handleViewFileInDiff = useCallback((path: string) => {
    setShowDiffPanel(true);
    setDiffFileRequest({ path, nonce: Date.now() });
  }, []);

  const toggleSystemPromptPanel = useCallback(() => {
    setShowSystemPromptPanel((prev) => !prev);
  }, []);

  const toggleSplitPanel = useCallback(() => {
    if (!splitPanelWorkspaceId) return;
    setSplitPanelWorkspaceKeys((prev) => {
      const isCurrentlyShown = prev[splitPanelWorkspaceId];
      if (!isCurrentlyShown) {
        setShowDiffPanel(false);
        setShowSystemPromptPanel(false);
      }
      return isCurrentlyShown
        ? clearSessionKeyFlag(prev, splitPanelWorkspaceId)
        : setSessionKeyFlag(prev, splitPanelWorkspaceId);
    });
  }, [splitPanelWorkspaceId]);

  /**
   * 分屏 Tab 关闭回调 — 终结对应后端 PTY 子进程组。
   *
   * sessionId 为 null 表示 Tab 在 CLI 会话建立前就被关闭（例如刚 createTab
   * 就立刻点 ×），此时后端尚无 PTY，无需终结。
   *
   * closeTerminalSession 可能抛 "Unknown terminal session"（CLI 自然退出后
   * 后端已清理、或远程 agent cleanup 已先行 close 过），吞掉即可——这是
   * best-effort 的幂等清理，绝不阻塞 UI 移除 Tab。
   */
  const handleSplitPanelTabClosed = useCallback(
    (_tabId: string, sessionId: string | null) => {
      if (!api || !sessionId) {
        return;
      }
      void api.closeTerminalSession(sessionId).catch(() => {
        // 会话可能已自然退出或被远程 agent cleanup 提前终结，忽略。
      });
    },
    [api],
  );

  useEffect(() => {
    const removeOpenCodingCliListener = api?.onOpenCodingCli?.((event) => {
      if (!event.workspaceId || !event.tabId || !isSplitPanelCliType(event.cliType)) {
        return;
      }
      setShowDiffPanel(false);
      setShowSystemPromptPanel(false);
      setSplitPanelWorkspaceKeys((prev) => setSessionKeyFlag(prev, event.workspaceId));
      setPendingOpenCodingCli(event);
    });
    return () => {
      removeOpenCodingCliListener?.();
    };
  }, [api]);

  useEffect(() => {
    const removeCloseCodingCliListener = api?.onCloseCodingCli?.(async (event) => {
      if (!event?.tabId) {
        return;
      }
      // 先取出后端 PTY 真实 sessionId（event.tabId 是前端 split-tab-N 标识，
      // 不能直接传给 closeTerminalSession，否则后端抛 "Unknown terminal
      // session" 而子进程成为孤儿）。必须在 closeTab 之前取，否则状态已清。
      const tab = splitPanelTabs.getTab(event.tabId);
      const sessionId = tab?.sessionId ?? null;
      if (sessionId && api?.closeTerminalSession) {
        try {
          await api.closeTerminalSession(sessionId);
        } catch {
          // PTY 可能已退出，忽略。
        }
      }
      splitPanelTabs.closeTab(event.tabId);
    });
    return () => {
      removeCloseCodingCliListener?.();
    };
  }, [api, splitPanelTabs]);

  useEffect(() => {
    if (!pendingOpenCodingCli || pendingOpenCodingCli.workspaceId !== splitPanelWorkspaceId) {
      return;
    }
    if (!splitPanelTabs.getTab(pendingOpenCodingCli.tabId)) {
      splitPanelTabs.createTab({
        id: pendingOpenCodingCli.tabId,
        cliType: pendingOpenCodingCli.cliType,
        cwd: pendingOpenCodingCli.workspacePath,
        prompt: pendingOpenCodingCli.prompt,
      });
    }
    splitPanelTabs.activateTab(pendingOpenCodingCli.tabId);
    setPendingOpenCodingCli(null);
  }, [pendingOpenCodingCli, splitPanelTabs, splitPanelWorkspaceId]);

  const toggleDiffPanel = useCallback(() => {
    const pane = timelinePaneRef.current;
    const shouldPreserveBottom = pane ? isNearBottom(pane) || pinnedToBottomRef.current : pinnedToBottomRef.current;
    if (shouldPreserveBottom) {
      preserveBottomOnNextPaneResizeRef.current = true;
    }

    setShowDiffPanel((prev) => !prev);

    if (!shouldPreserveBottom) {
      return;
    }

    schedulePinnedBottomRealignment(3);
  }, [schedulePinnedBottomRealignment]);

  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
    if (!api) {
      return;
    }
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : rootWorkspace?.id || settingsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSettingsWorkspaceId(nextWorkspaceId);
    }
    if (section) {
      setSettingsSection(section);
    }
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("settings"));
  };

  const closeTreeModal = useCallback(() => {
    setTreeModalState((current) =>
      current.submitting
        ? current
        : {
            open: false,
            loading: false,
            submitting: false,
          },
    );
    focusComposer();
  }, []);

  const openTreeModal = useCallback(() => {
    if (!api || !selectedWorkspace || !selectedSession) {
      return;
    }

    setTreeModalState({
      open: true,
      loading: true,
      submitting: false,
    });

    void api
      .getSessionTree({
        workspaceId: selectedWorkspace.id,
        sessionId: selectedSession.id,
      })
      .then((tree) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          tree,
        });
      })
      .catch((error) => {
        setTreeModalState({
          open: true,
          loading: false,
          submitting: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [api, selectedSession, selectedWorkspace]);

  const navigateTreeSelection = useCallback(
    (targetId: string, options?: { readonly summarize?: boolean; readonly customInstructions?: string }) => {
      if (!api || !selectedWorkspace || !selectedSession) {
        return;
      }

      setTreeModalState((current) => ({ ...current, submitting: true, error: undefined }));
      void api
        .navigateSessionTree(
          {
            workspaceId: selectedWorkspace.id,
            sessionId: selectedSession.id,
          },
          targetId,
          options,
        )
        .then(({ state, result }) => {
          setSnapshot(state);
          setTreeModalState({
            open: false,
            loading: false,
            submitting: false,
          });
          focusComposer();
        })
        .catch((error) => {
          setTreeModalState((current) => ({
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [api, selectedSession, selectedWorkspace],
  );

  const wsMenu = useWorkspaceMenu({
    api,
    setSnapshot,
    updateSnapshot,
  });

  useEffect(() => {
    const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;
    if (!sessionExtensionUiBySession) {
      setDockExpandedBySession((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    setDockExpandedBySession((current) => {
      let next: Record<string, boolean> | undefined;
      for (const [sessionKey, expanded] of Object.entries(current)) {
        if (!expanded && sessionExtensionUiBySession[sessionKey]) {
          continue;
        }
        if (hasExtensionDockContent(sessionExtensionUiBySession[sessionKey])) {
          continue;
        }
        if (!next) {
          next = { ...current };
        }
        delete next[sessionKey];
      }
      return next ?? current;
    });
  }, [snapshot?.sessionExtensionUiBySession]);

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setSettingsWorkspaceId("");
      setSkillsWorkspaceId("");
      setExtensionsWorkspaceId("");
      setPendingNewThreadWorkspaceId("");
      setNewThreadRootWorkspaceId("");
      setNewThreadEnvironment("local");
      return;
    }
    setSettingsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setSkillsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setExtensionsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setNewThreadRootWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
  }, [rootWorkspaceOptions]);

  useEffect(() => {
    if (!snapshot || !pendingNewThreadWorkspaceId) {
      return;
    }
    const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, pendingNewThreadWorkspaceId);
    if (!nextRootWorkspaceId || !rootWorkspaceOptions.some((workspace) => workspace.id === nextRootWorkspaceId)) {
      return;
    }
    setNewThreadRootWorkspaceId(nextRootWorkspaceId);
    setPendingNewThreadWorkspaceId("");
  }, [pendingNewThreadWorkspaceId, rootWorkspaceOptions, snapshot]);

  const resetNewThreadSurface = (workspaceId?: string) => {
    const nextWorkspaceId =
      (workspaceId && (
        rootWorkspaceOptions.find((workspace) => workspace.id === workspaceId)?.id ||
        (snapshot ? resolveRepoWorkspaceId(snapshot.workspaces, workspaceId) : undefined)
      )) ||
      rootWorkspace?.id ||
      visibleWorkspaces[0]?.id ||
      "";
    if (nextWorkspaceId) {
      setNewThreadRootWorkspaceId(nextWorkspaceId);
    }
    setNewThreadEnvironment("local");
    setNewThreadPrompt("");
    setNewThreadProvider(undefined);
    setNewThreadModelId(undefined);
    setNewThreadThinkingLevel(undefined);
    setNewThreadComposerError(undefined);
  };

  const primarySidebarToggleVisible = canTogglePrimarySidebar(snapshot?.activeView);
  const handleTogglePrimarySidebar = useCallback(() => {
    const sidebarState = sidebarToggleStateRef.current;
    const sidebarApi = sidebarState.api;
    if (!sidebarApi || !canTogglePrimarySidebar(sidebarState.activeView)) {
      return false;
    }
    void updateSnapshot(sidebarApi, setSnapshot, () => sidebarApi.setSidebarCollapsed(!sidebarState.sidebarCollapsed));
    return true;
  }, []);
  const handleSidebarWidthChange = useCallback((nextWidth: number) => {
    setSidebarWidth(nextWidth);
  }, []);
  const handleSidebarWidthCommit = useCallback((nextWidth: number) => {
    setSidebarWidth(nextWidth);
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setSidebarWidth(nextWidth));
  }, [api, setSnapshot]);
  const sidebarToggleShortcutLabel = api ? getDesktopShortcutLabel(api.platform, "B") : "";

  useEffect(() => {
    const handleCommand = (command: PiDesktopCommand): boolean => {
      if (command === desktopCommands.openSettings) {
        openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
        return true;
      } else if (command === desktopCommands.openNewThread) {
        openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
        return true;
      } else if (command === desktopCommands.toggleTerminal) {
        toggleTerminal();
        return true;
      } else if (command === desktopCommands.toggleSidebar) {
        return handleTogglePrimarySidebar();
      }
      return false;
    };

    const removeCommandListener = window.piApp?.onCommand?.(handleCommand);
    const removeWorkspacePickedListener = window.piApp?.onWorkspacePicked?.((workspaceId) => {
      setPendingNewThreadWorkspaceId(workspaceId);
      resetNewThreadSurface();
    });
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isEventInsideTerminal(event)) {
        const command = getDesktopCommandFromShortcut({
          modifier: event.metaKey || event.ctrlKey,
          shift: event.shiftKey,
          key: event.key,
          code: event.code,
        });
        if (command === desktopCommands.toggleTerminal) {
          event.preventDefault();
          handleCommand(command);
        }
        return;
      }
      // Cmd+F toggles thread search
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !event.shiftKey) {
        event.preventDefault();
        if (threadSearch.isOpen) {
          threadSearch.close();
        } else {
          threadSearch.open();
        }
        return;
      }
      // Cmd+D toggles diff panel
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && !event.shiftKey) {
        event.preventDefault();
        toggleDiffPanel();
        return;
      }
      // Cmd+Shift+P toggles split panel
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p" && event.shiftKey) {
        event.preventDefault();
        toggleSplitPanel();
        return;
      }
      const command = getDesktopCommandFromShortcut({
        modifier: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      });
      if (command && handleCommand(command)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      removeCommandListener?.();
      removeWorkspacePickedListener?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    selectedWorkspace?.id,
    selectedWorkspace?.rootWorkspaceId,
    threadSearch,
    api,
    toggleDiffPanel,
    toggleTerminal,
    handleTogglePrimarySidebar,
  ]);

  useLayoutEffect(() => {
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = true;
    previousTimelinePaneSizeRef.current = null;
    preserveBottomOnNextPaneResizeRef.current = false;
    resetExactBottomRestoreState(selectedSessionKey || null);
    setDisableTimelineVirtualization(Boolean(selectedSessionKey));
  }, [selectedSessionKey]);

  useLayoutEffect(() => {
    if (snapshot?.activeView !== "threads" || !selectedSession || activeTranscript.length === 0) {
      return;
    }
    if (exactBottomRestoreSessionKeyRef.current !== selectedSessionKey) {
      return;
    }
    if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
      return;
    }

    scrollTimelineToBottom();
  }, [
    activeTranscript,
    disableTimelineVirtualization,
    scrollTimelineToBottom,
    selectedSession,
    selectedSessionKey,
    snapshot?.activeView,
  ]);

  useEffect(() => {
    setTreeModalState((current) =>
      current.open
        ? {
            open: false,
            loading: false,
            submitting: false,
          }
        : current,
    );
  }, [selectedSessionKey, snapshot?.activeView]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (snapshot.activeView === "new-thread" && previousActiveViewRef.current !== "new-thread") {
      const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace?.id);
      if (nextRootWorkspaceId) {
        setNewThreadRootWorkspaceId(nextRootWorkspaceId);
      }
    }

    if (snapshot.activeView !== "threads") {
      previousTimelinePaneSizeRef.current = null;
      resetExactBottomRestoreState();
    }

    if (
      snapshot.activeView === "threads" &&
      previousActiveViewRef.current !== "threads" &&
      selectedSession
    ) {
      focusComposer();
      if (pinnedToBottomRef.current || preserveBottomOnNextPaneResizeRef.current) {
        preserveBottomOnNextPaneResizeRef.current = true;
        schedulePinnedBottomRealignment(1);
      }
    }

    previousActiveViewRef.current = snapshot.activeView;
  }, [schedulePinnedBottomRealignment, selectedSession, selectedWorkspace?.id, snapshot]);

  useLayoutEffect(() => {
    if (snapshot?.activeView !== "threads" || !selectedSession) {
      return undefined;
    }

    return () => {
      const pane = timelinePaneRef.current;
      if (!pane) {
        return;
      }
      lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
      lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, isNearBottom(pane));
    };
  }, [selectedSession, selectedSessionKey, snapshot?.activeView]);

  useLayoutEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSession || snapshot?.activeView !== "threads") {
      previousTimelinePaneSizeRef.current = null;
      return undefined;
    }

    const stickToBottomAfterLayoutChange = () => {
      preserveBottomOnNextPaneResizeRef.current = false;
      pinnedToBottomRef.current = true;
      window.requestAnimationFrame(() => {
        requestPinnedBottomAlignment("auto", { preferExactRestore: true });
        window.requestAnimationFrame(() => {
          if (pinnedToBottomRef.current) {
            requestPinnedBottomAlignment("auto", { preferExactRestore: true });
          }
        });
      });
    };

    const updateMeasuredSize = (nextSize: { width: number; height: number }) => {
      const previousSize = previousTimelinePaneSizeRef.current;
      previousTimelinePaneSizeRef.current = nextSize;
      const shouldStickToBottom = preserveBottomOnNextPaneResizeRef.current || pinnedToBottomRef.current;
      const widthChanged = previousSize ? Math.abs(nextSize.width - previousSize.width) >= 1 : false;
      const heightChanged = previousSize ? Math.abs(nextSize.height - previousSize.height) >= 1 : false;
      if (!previousSize || (!widthChanged && !heightChanged) || !shouldStickToBottom) {
        return;
      }

      stickToBottomAfterLayoutChange();
    };

    const paneRect = pane.getBoundingClientRect();
    updateMeasuredSize({ width: paneRect.width, height: paneRect.height });

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      updateMeasuredSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });

    resizeObserver.observe(pane);
    return () => {
      resizeObserver.disconnect();
      previousTimelinePaneSizeRef.current = null;
    };
  }, [requestPinnedBottomAlignment, selectedSessionKey, showDiffPanel, snapshot?.activeView, timelinePaneMountVersion]);

  useEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSession) {
      return;
    }

    const marker = buildTranscriptChangeMarker(selectedSessionKey, activeTranscript);
    if (marker === lastTranscriptMarkerRef.current) {
      return;
    }
    lastTranscriptMarkerRef.current = marker;

    if (pinnedToBottomRef.current) {
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
      return;
    }

    setShowJumpToLatest(true);
  }, [activeTranscript, requestPinnedBottomAlignment, selectedSession, selectedSessionKey]);

  const handleTimelineContentHeightChange = useCallback(() => {
    if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!pinnedToBottomRef.current && !preserveBottomOnNextPaneResizeRef.current) {
        return;
      }
      requestPinnedBottomAlignment("auto", { preferExactRestore: true });
    });
  }, [requestPinnedBottomAlignment]);

  if (authorizationRequired) {
    const loginLocale = resolveLocale("auto");
    return (
      <I18nProvider locale="auto" resolvedLocale={loginLocale}>
        <RemoteUiLogin />
      </I18nProvider>
    );
  }

  if (!api || !snapshot) {
    return (
      <div className="shell shell--loading">
        <main className="loading-card">
          <div className="loading-card__eyebrow">{t("app.loading.eyebrow")}</div>
          <h1>{t("app.loading.title")}</h1>
          <p>{t("app.loading.body")}</p>
        </main>
      </div>
    );
  }

  const i18nWrapper = (children: ReactNode) => (
    <I18nProvider locale={snapshot.locale} resolvedLocale={resolvedLocale}>{children}</I18nProvider>
  );

  const showTerminalTakeover = isTerminalVisibleForSelectedThread && isTerminalTakeoverForSelectedThread && Boolean(selectedWorkspace);
  const showTuiTakeover = Boolean(tuiTabs.openSessionKey && tuiWorkspace && tuiLaunchConfig);
  const showTuiWithTerminal = showTuiTakeover && isTerminalVisibleForSelectedThread;
  const mainClassName = [
    "main",
    showSystemPromptPanel ? "main--with-system-prompt" : "",
    showDiffPanel ? "main--with-diff" : "",
    isTerminalVisibleForSelectedThread || showTuiTakeover ? "main--with-terminal" : "",
    showTerminalTakeover || (showTuiTakeover && !isTerminalVisibleForSelectedThread) ? "main--terminal-takeover" : "",
    showTuiWithTerminal ? "main--tui-with-terminal" : "",
  ].filter(Boolean).join(" ");
  const terminalPanel = isTerminalVisibleForSelectedThread && selectedWorkspace ? (
    <TerminalPanel
      workspace={selectedWorkspace}
      sessionId={selectedSession?.id ?? ""}
      height={terminalHeight}
      isTakeover={isTerminalTakeoverForSelectedThread}
      onHeightChange={(nextHeight) => {
        setTerminalHeight(nextHeight);
        if (!selectedSessionKey) {
          return;
        }
        setTakeoverTerminalSessionKeys((current) => clearSessionKeyFlag(current, selectedSessionKey));
      }}
      onToggleTakeover={() => {
        if (!selectedSessionKey || !openTerminalSessionKeys[selectedSessionKey]) {
          return;
        }
        setTakeoverTerminalSessionKeys((current) =>
          current[selectedSessionKey]
            ? clearSessionKeyFlag(current, selectedSessionKey)
            : setSessionKeyFlag(current, selectedSessionKey),
        );
      }}
      onHide={() => {
        if (selectedSessionKey) {
          setOpenTerminalSessionKeys((current) => clearSessionKeyFlag(current, selectedSessionKey));
          setTakeoverTerminalSessionKeys((current) => clearSessionKeyFlag(current, selectedSessionKey));
        }
        focusComposer();
      }}
    />
  ) : null;
  const tuiPanel = showTuiTakeover && tuiWorkspace && tuiLaunchConfig ? (
    <TerminalPanel
      key={tuiTerminalScopeId}
      workspace={tuiWorkspace}
      sessionId={tuiSessionId ?? tuiTabs.openSessionKey}
      terminalScopeId={tuiTerminalScopeId}
      launchConfig={tuiLaunchConfig}
      reattachEpoch={tuiReattachEpoch}
      height={terminalHeight}
      isTakeover
      allowMultipleSessions
      allowCreateSession={false}
      testId="pi-tui-terminal"
      workspacePath={tuiWorkspace?.path ?? ""}
      surfaceBgColor={snapshot.tuiBgColor}
      tuiHeaderActions={(
        <HeaderActions
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          terminalAvailable={isThreadsView && Boolean(selectedSessionKey)}
          terminalVisible={isTerminalVisibleForSelectedThread}
          onToggleTerminal={toggleTerminal}
          showDiffPanel={showDiffPanel}
          onToggleDiffPanel={toggleDiffPanel}
          showSystemPromptPanel={showSystemPromptPanel}
          onToggleSystemPromptPanel={toggleSystemPromptPanel}
          showSplitPanel={showSplitPanel}
          onToggleSplitPanel={toggleSplitPanel}
          variant={isMobile ? "menu" : "toolbar"}
        />
      )}
      onHeightChange={setTerminalHeight}
      onToggleTakeover={hideTuiMode}
      onHide={hideTuiMode}
      onActiveSessionChange={(terminalSession) => {
        if (terminalSession.launchConfig.mode !== "pi-tui" || !terminalSession.launchConfig.sessionId) {
          const tabKey = getTuiTabKeyForTerminalSession(terminalSession);
          if (tabKey) {
            tuiTabs.activateKey(tabKey);
          }
          return;
        }
        const target = {
          workspaceId: terminalSession.workspaceId,
          sessionId: terminalSession.launchConfig.sessionId,
        };
        tuiTabs.activateExisting(target);
        void updateSnapshot(api, setSnapshot, () => api.selectSession(target));
      }}
      onSessionClosed={(terminalSession, nextActiveSession) => {
        const closedKey = getTuiTabKeyForTerminalSession(terminalSession);
        const nextActiveKey = nextActiveSession ? getTuiTabKeyForTerminalSession(nextActiveSession) : undefined;
        if (!closedKey) {
          return;
        }
        closeTuiMode(closedKey, nextActiveKey);
      }}
    />
  ) : null;

  const setActiveView = (view: AppView) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView(view));
  };

  const openSkills = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : skillsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSkillsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("skills");
  };

  const openExtensions = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : extensionsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setExtensionsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("extensions");
  };

  const openNewThreadSurface = (workspaceId?: string) => {
    const nextWorkspaceId =
      (workspaceId && (
        rootWorkspaceOptions.find((workspace) => workspace.id === workspaceId)?.id ||
        (snapshot ? resolveRepoWorkspaceId(snapshot.workspaces, workspaceId) : undefined)
      )) ||
      rootWorkspace?.id ||
      visibleWorkspaces[0]?.id ||
      "";
    setPendingNewThreadWorkspaceId("");
    resetNewThreadSurface(workspaceId);
    if (nextWorkspaceId) {
      const res = tuiTabs.openNew(nextWorkspaceId);
      if (!res.success) {
        showTuiLimitError();
      } else {
        res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      }
    }
    setActiveView("threads");
  };

  const handleSelectNewThreadWorkspace = (workspaceId: string) => {
    setPendingNewThreadWorkspaceId("");
    setNewThreadRootWorkspaceId(workspaceId);
    setNewThreadProvider(undefined);
    setNewThreadModelId(undefined);
    setNewThreadThinkingLevel(undefined);
    setNewThreadComposerError(undefined);
  };

  const handleSetSessionModel = (provider: string, modelId: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.setSessionModel(selectedWorkspace.id, selectedSession.id, provider, modelId),
    );
  };

  const handleSetSessionThinking = (level: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.setSessionThinkingLevel(
        selectedWorkspace.id,
        selectedSession.id,
        level as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
      ),
    );
  };

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setDefaultModel(undefined, provider, modelId));
  };

  const handleSetThinkingLevel = (thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"]) => {
    void updateSnapshot(api, setSnapshot, () => api.setDefaultThinkingLevel(undefined, thinkingLevel));
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setEnableSkillCommands(settingsWorkspace.id, enabled));
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    void updateSnapshot(api, setSnapshot, () => api.setScopedModelPatterns(undefined, patterns));
  };

  const handleLoginProvider = (providerId: string) => {
    void updateSnapshot(api, setSnapshot, () => api.loginProvider(undefined, providerId));
  };

  const handleLogoutProvider = (providerId: string) => {
    void updateSnapshot(api, setSnapshot, () => api.logoutProvider(undefined, providerId));
  };

  const handleSetProviderApiKey = async (providerId: string, apiKey: string): Promise<string | undefined> => {
    if (!api) {
      return t("app.error.desktopApiUnavailable");
    }
    const state = await updateSnapshot(api, setSnapshot, () =>
      api.setProviderApiKey(undefined, providerId, apiKey),
    );
    return state.lastError;
  };

  const handleRemoveProviderApiKey = async (providerId: string): Promise<string | undefined> => {
    if (!api) {
      return t("app.error.desktopApiUnavailable");
    }
    const state = await updateSnapshot(api, setSnapshot, () =>
      api.logoutProvider(undefined, providerId),
    );
    return state.lastError;
  };


  const handleMcpStateAction = async (action: () => Promise<DesktopAppState>): Promise<string | undefined> => {
    if (!api) {
      return t("app.error.desktopApiUnavailable");
    }
    const state = await updateSnapshot(api, setSnapshot, action);
    return state.lastError;
  };

  const handleAddMcpServer = (input: McpServerConfigInput): Promise<string | undefined> =>
    handleMcpStateAction(() => api.addMcpServer(input));

  const handleUpdateMcpServer = (serverId: string, input: McpServerConfigInput): Promise<string | undefined> =>
    handleMcpStateAction(() => api.updateMcpServer(serverId, input));

  const handleRemoveMcpServer = (serverId: string): Promise<string | undefined> =>
    handleMcpStateAction(() => api.removeMcpServer(serverId));

  const handleAuthorizeMcpServer = (serverId: string): Promise<string | undefined> =>
    handleMcpStateAction(() => api.authorizeMcpServer(serverId));

  const handleSetMcpServerEnabled = (serverId: string, enabled: boolean): Promise<string | undefined> =>
    handleMcpStateAction(() => api.setMcpServerEnabled(serverId, enabled));

  const handleSetCliEnabled = (cliType: string, enabled: boolean): Promise<string | undefined> =>
    handleMcpStateAction(() => api.setCliEnabled(cliType, enabled));

  const handleDetectAllCli = async () => {
    if (!api) {
      throw new Error(t("app.error.desktopApiUnavailable"));
    }
    return api.detectAllCli();
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!skillsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setSkillEnabled(skillsWorkspace.id, filePath, enabled));
  };

  const handleRemoveSkill = async (filePath: string): Promise<string | undefined> => {
    if (!api || !skillsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    const state = await updateSnapshot(api, setSnapshot, () => api.removeSkill(skillsWorkspace.id, filePath));
    return state.lastError;
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!skillsWorkspace) {
      return;
    }
    void api.openSkillInFinder(skillsWorkspace.id, filePath);
  };

  const handleToggleExtension = (filePath: string, enabled: boolean) => {
    if (!extensionsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setExtensionEnabled(extensionsWorkspace.id, filePath, enabled));
  };

  const handleRemoveExtension = async (filePath: string): Promise<string | undefined> => {
    if (!api || !extensionsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    const state = await updateSnapshot(api, setSnapshot, () => api.removeExtension(extensionsWorkspace.id, filePath));
    return state.lastError;
  };

  const handleInstallPackage = async (source: string): Promise<string | undefined> => {
    if (!api || !extensionsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    if (!source) {
      return t("app.error.addPackageSource");
    }

    const state = await updateSnapshot(api, setSnapshot, () => api.installPackage(extensionsWorkspace.id, source));
    return state.lastError;
  };

  const handleUpdatePackage = async (
    source: string,
    installScope: "user" | "project",
  ): Promise<string | undefined> => {
    if (!api || !extensionsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    const state = await updateSnapshot(api, setSnapshot, () =>
      api.updatePackage(extensionsWorkspace.id, source, installScope),
    );
    return state.lastError;
  };

  const handleTogglePackage = async (source: string, enabled: boolean): Promise<string | undefined> => {
    if (!api || !extensionsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    const state = await updateSnapshot(api, setSnapshot, () => api.setPackageEnabled(extensionsWorkspace.id, source, enabled));
    return state.lastError;
  };

  const handleRemovePackage = async (source: string, installScope: "user" | "project"): Promise<string | undefined> => {
    if (!api || !extensionsWorkspace) {
      return t("app.error.selectWorkspaceFirst");
    }

    const state = await updateSnapshot(api, setSnapshot, () => api.removePackage(extensionsWorkspace.id, source, installScope));
    return state.lastError;
  };

  const handleOpenExtensionFolder = (filePath: string) => {
    if (!extensionsWorkspace) {
      return;
    }
    void api.openExtensionInFinder(extensionsWorkspace.id, filePath);
  };

  const handleTrySkill = (_command: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("threads"));
    if (selectedWorkspace && selectedSession) {
      const res = tuiTabs.openExisting({ workspaceId: selectedWorkspace.id, sessionId: selectedSession.id });
      if (!res.success) {
        showTuiLimitError();
      }
      res.evictedKeys.forEach(reloadClosedTuiSessionKey);
      return;
    }
    const workspaceId = selectedWorkspace?.id ?? rootWorkspace?.id ?? visibleWorkspaces[0]?.id;
    if (workspaceId) {
      const res = tuiTabs.openNew(workspaceId);
      if (!res.success) {
        showTuiLimitError();
      }
      res.evictedKeys.forEach(reloadClosedTuiSessionKey);
    }
  };

  const handleSetThemeMode = (mode: "system" | "light" | "dark") => {
    if (!api) return;
    setThemeMode(mode);
    void api.setThemeMode(mode);
  };

  const handleSetNotificationPreferences = (preferences: Partial<DesktopAppState["notificationPreferences"]>) => {
    void updateSnapshot(api, setSnapshot, () => api.setNotificationPreferences(preferences));
  };

  const handleSetIntegratedTerminalShell = (shellPath: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setIntegratedTerminalShell(shellPath));
  };

  const handleSetTuiTabLimit = (limit: number) => {
    void updateSnapshot(api, setSnapshot, () => api.setTuiTabLimit(limit));
  };

  const handleSetRemoteUiToken = (token: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setRemoteUiToken(token));
  };

  const handleSetRemoteUiPort = (port: number) => {
    void updateSnapshot(api, setSnapshot, () => api.setRemoteUiPort(port));
  };

  const handleRequestNotificationPermission = () => {
    if (!api?.requestNotificationPermission) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .requestNotificationPermission()
      .then((status) => {
        setNotificationPermissionStatus(status);
      })
      .finally(() => {
        setNotificationPermissionPending(false);
      });
  };

  const handleOpenSystemNotificationSettings = () => {
    if (!api?.openSystemNotificationSettings) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .openSystemNotificationSettings()
      .finally(() => {
        setNotificationPermissionPending(false);
      });
  };

  const handleArchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.archiveSession(target));
  };

  const handleSelectSession = (target: WorkspaceSessionTarget) => {
    const traceId = getTuiPerfTraceId(target.workspaceId, target.sessionId);

    void (async () => {
      if (!hasTuiTabForTarget(tuiTabs.tabs, target) && api?.findBackgroundPiTuiSession) {
        const backgroundPiTui = await api.findBackgroundPiTuiSession(target.workspaceId, target.sessionId);
        logTuiPerf("renderer.sidebar.selectSession.backgroundPiTui", {
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          traceId,
        }, {
          found: Boolean(backgroundPiTui),
          terminalId: backgroundPiTui?.terminalId,
          seq: backgroundPiTui?.seq,
          status: backgroundPiTui?.status,
        });
      }

      logTuiPerf("renderer.sidebar.selectSession.click", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        traceId,
      }, {
        shouldRestoreTuiPanel: true,
        previousOpenTuiSessionKey: tuiTabs.activeKeyRef.current,
      });

      const res = tuiTabs.openExisting(target);
      if (!res.success) {
        showTuiLimitError();
      } else {
        res.evictedKeys.forEach(reloadClosedTuiSessionKey);
        setTuiReattachEpoch((epoch) => epoch + 1);
      }
      const nextTuiKey = createExistingTuiSessionKey(target);
      logTuiPerf("renderer.sidebar.selectSession.setTuiTarget", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        traceId,
      }, {
        nextTuiKey,
      });

      await updateSnapshot(api, setSnapshot, () => api.selectSession(target));
      logTuiPerf("renderer.sidebar.selectSession.snapshotUpdated", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        traceId,
      }, {
        shouldRestoreTuiPanel: true,
      });
    })();
  };

  const handleRespondToExtensionDialog = (
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }

    void updateSnapshot(api, setSnapshot, () =>
      api.respondToHostUiRequest(selectedWorkspace.id, selectedSession.id, response),
    ).then(() => {
      focusComposer();
    });
  };

  const handleToggleExtensionDock = () => {
    if (!selectedExtensionDock) {
      return;
    }

    setDockExpandedBySession((current) => ({
      ...current,
      [selectedSessionKey]: !(current[selectedSessionKey] ?? false),
    }));
  };

  const handleUnarchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.unarchiveSession(target));
  };

  const handleStartThread = () => {
    if (!newThreadRootWorkspaceId) {
      return;
    }
    wsMenu.expandWorkspace(newThreadRootWorkspaceId);
    const res = tuiTabs.openNew(newThreadRootWorkspaceId);
    if (!res.success) {
      showTuiLimitError();
      return;
    }
    res.evictedKeys.forEach(reloadClosedTuiSessionKey);
    setNewThreadPrompt("");
    setNewThreadProvider(undefined);
    setNewThreadModelId(undefined);
    setNewThreadThinkingLevel(undefined);
    setNewThreadEnvironment("local");
    setActiveView("threads");
  };

  const handleTimelineScroll = () => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    const pinned = isNearBottom(pane);
    if (preserveBottomOnNextPaneResizeRef.current && !pinned) {
      return;
    }

    pinnedToBottomRef.current = pinned;
    lastTimelineScrollTopBySessionRef.current.set(selectedSessionKey, pane.scrollTop);
    lastTimelinePinnedBySessionRef.current.set(selectedSessionKey, pinned);
    if (pinned) {
      setShowJumpToLatest(false);
    }
  };

  const jumpToLatest = () => {
    requestPinnedBottomAlignment("smooth", { preferExactRestore: true });
  };

  const settingsNav = [
    { id: "appearance", label: t("settings.nav.appearance") },
    { id: "general", label: t("settings.nav.general") },
    { id: "providers", label: t("settings.nav.providers") },
    { id: "models", label: t("settings.nav.models") },
    { id: "mcp", label: t("settings.nav.mcp") },
    { id: "cli", label: t("settings.nav.cli") },
    { id: "notifications", label: t("settings.nav.notifications") },
  ] as const;

  if (snapshot.activeView === "settings") {
    return i18nWrapper(
      <SecondarySurface
        activeNavId={settingsSection}
        navItems={settingsNav}
        onBack={() => setActiveView("threads")}
        onSelectNav={(section) => setSettingsSection(section as SettingsSection)}
        testId="settings-surface"
        title={t("settings.title")}
      >
        <SettingsView
          workspace={settingsViewWorkspace}
          runtime={settingsSection === "models" || settingsSection === "providers" ? globalSettingsRuntime : settingsRuntime}
          section={settingsSection}
          notificationPreferences={snapshot.notificationPreferences}
          notificationPermissionStatus={notificationPermissionStatus}
          notificationPermissionPending={notificationPermissionPending}
          integratedTerminalShell={snapshot.integratedTerminalShell}
          tuiTabLimit={snapshot.tuiTabLimit}
          remoteUiPort={snapshot.remoteUiPort}
          remoteUiToken={snapshot.remoteUiToken}
          remoteUiStatus={snapshot.remoteUiStatus}
          themeMode={themeMode}
          enableTransparency={snapshot.enableTransparency}
          tuiBgColor={snapshot.tuiBgColor}
          splitPanelBgColor={snapshot.splitPanelBgColor}
          locale={snapshot.locale}
          onSetLocale={(locale: LocaleSetting) => {
            void updateSnapshot(api, setSnapshot, () => api.setLocale(locale));
          }}
          mcpServers={snapshot.mcpServers}
          cliEnablement={snapshot.cliEnablement}
          onLoginProvider={handleLoginProvider}
          onLogoutProvider={handleLogoutProvider}
          onSetProviderApiKey={handleSetProviderApiKey}
          onRemoveProviderApiKey={handleRemoveProviderApiKey}
          onAddMcpServer={handleAddMcpServer}
          onUpdateMcpServer={handleUpdateMcpServer}
          onRemoveMcpServer={handleRemoveMcpServer}
          onAuthorizeMcpServer={handleAuthorizeMcpServer}
          onSetMcpServerEnabled={handleSetMcpServerEnabled}
          onSetCliEnabled={handleSetCliEnabled}
          onDetectAllCli={handleDetectAllCli}
          onSetDefaultModel={handleSetDefaultModel}
          onSetNotificationPreferences={handleSetNotificationPreferences}
          onSetIntegratedTerminalShell={handleSetIntegratedTerminalShell}
          onSetTuiTabLimit={handleSetTuiTabLimit}
          onSetRemoteUiPort={handleSetRemoteUiPort}
          onSetRemoteUiToken={handleSetRemoteUiToken}
          onRequestNotificationPermission={handleRequestNotificationPermission}
          onOpenSystemNotificationSettings={handleOpenSystemNotificationSettings}
          onSetScopedModelPatterns={handleSetScopedModelPatterns}
          onSetThemeMode={handleSetThemeMode}
          onSetThinkingLevel={handleSetThinkingLevel}
          onToggleSkillCommands={handleToggleSkillCommands}
          onSetEnableTransparency={(enabled) => {
            void updateSnapshot(api, setSnapshot, () => api.setEnableTransparency(enabled));
          }}
          onSetTuiBgColor={(color) => {
            void updateSnapshot(api, setSnapshot, () => api.setTuiBgColor(color));
          }}
          onSetSplitPanelBgColor={(color) => {
            void updateSnapshot(api, setSnapshot, () => api.setSplitPanelBgColor(color));
          }}
        />
      </SecondarySurface>
    );
  }

  if (snapshot.activeView === "skills") {
    return i18nWrapper(
      <SecondarySurface onBack={() => setActiveView("threads")} testId="skills-surface" title={t("app.surface.skills")}>
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>{t("app.surface.workspace")}</span>
            <select
              value={skillsWorkspace?.id ?? ""}
              onChange={(event) => setSkillsWorkspaceId(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SkillsView
          workspace={skillsWorkspace}
          runtime={skillsRuntime}
          onOpenSkillFolder={handleOpenSkillFolder}
          onRefresh={() => {
            if (!skillsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(skillsWorkspace.id));
          }}
          onToggleSkill={handleToggleSkill}
          onRemoveSkill={handleRemoveSkill}
          onTrySkill={(skill) =>
            handleTrySkill(
              skill.filePath
                ? `${skill.slashCommand} `
                : "Create a new skill for this workspace and explain which files you will add.",
            )
          }
        />
      </SecondarySurface>
    );
  }

  if (snapshot.activeView === "extensions") {
    return i18nWrapper(
      <SecondarySurface onBack={() => setActiveView("threads")} testId="extensions-surface" title={t("app.surface.extensions")}>
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>{t("app.surface.workspace")}</span>
            <select
              value={extensionsWorkspace?.id ?? ""}
              onChange={(event) => setExtensionsWorkspaceId(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExtensionsView
          workspace={extensionsWorkspace}
          runtime={extensionsRuntime}
          commandCompatibility={extensionsCommandCompatibility}
          onOpenExtensionFolder={handleOpenExtensionFolder}
          onRefresh={() => {
            if (!extensionsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(extensionsWorkspace.id));
          }}
          onRemoveExtension={handleRemoveExtension}
          onInstallPackage={handleInstallPackage}
          onUpdatePackage={handleUpdatePackage}
          onTogglePackage={handleTogglePackage}
          onRemovePackage={handleRemovePackage}
          onToggleExtension={handleToggleExtension}
        />
      </SecondarySurface>
    );
  }

  const shellClassName = `shell${snapshot.sidebarCollapsed ? " shell--sidebar-collapsed" : ""}${showSplitPanel ? " shell--with-split-panel" : ""}`;
  const shellStyle = { ["--sidebar-width" as "--sidebar-width"]: `${sidebarWidth}px` } as CSSProperties & Record<"--sidebar-width", string>;
  // TUI takeover hides the topbar; keep a floating expand control when the sidebar is collapsed.
  const showFloatingSidebarToggle =
    primarySidebarToggleVisible && snapshot.sidebarCollapsed && showTuiTakeover;

  return i18nWrapper(
    <div className={shellClassName} style={shellStyle}>
      {showFloatingSidebarToggle ? (
        <SidebarToggleButton
          className="sidebar-toggle--floating"
          collapsed
          shortcutLabel={sidebarToggleShortcutLabel}
          onToggle={handleTogglePrimarySidebar}
        />
      ) : null}
      {!snapshot.sidebarCollapsed || isMobile ? (
        <Sidebar
          activeView={snapshot.activeView}
          selectedWorkspace={selectedWorkspace}
          selectedSession={selectedSession}
          visibleWorkspaces={visibleWorkspaces}
          threadGroups={threadGroups}
          linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
          wsMenu={wsMenu}
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          sidebarToggleVisible={primarySidebarToggleVisible}
          sidebarToggleShortcutLabel={sidebarToggleShortcutLabel}
          onToggleSidebar={handleTogglePrimarySidebar}
          onNewThread={() => openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          onNewThreadForWorkspace={(workspaceId) => openNewThreadSurface(workspaceId)}
          onSetActiveView={setActiveView}
          onOpenSkills={openSkills}
          onOpenExtensions={openExtensions}
          onOpenSettings={openSettings}
          onArchiveSession={handleArchiveSession}
          onSelectSession={handleSelectSession}
          onUnarchiveSession={handleUnarchiveSession}
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={handleSidebarWidthChange}
          onSidebarWidthCommit={handleSidebarWidthCommit}
        />
      ) : null}

      <main className={mainClassName}>
        {!showTuiTakeover ? (
          <Topbar
            activeView={snapshot.activeView}
            rootWorkspace={rootWorkspace}
            selectedWorkspace={selectedWorkspace}
            selectedSession={selectedSession}
            selectedSessionTitle={displayedSessionTitle || selectedSession?.title}
            selectedWorktree={selectedWorktree}
            activeWorktrees={activeWorktrees}
            workspaces={snapshot.workspaces}
            wsMenu={wsMenu}
            api={api}
            setSnapshot={setSnapshot}
            updateSnapshot={updateSnapshot}
            terminalAvailable={isThreadsView && Boolean(selectedSessionKey)}
            terminalVisible={isTerminalVisibleForSelectedThread}
            onToggleTerminal={toggleTerminal}
            showDiffPanel={showDiffPanel}
            onToggleDiffPanel={toggleDiffPanel}
            showSystemPromptPanel={showSystemPromptPanel}
            onToggleSystemPromptPanel={toggleSystemPromptPanel}
            showSplitPanel={showSplitPanel}
            onToggleSplitPanel={toggleSplitPanel}
            sidebarToggleVisible={primarySidebarToggleVisible && snapshot.sidebarCollapsed}
            sidebarToggleShortcutLabel={sidebarToggleShortcutLabel}
            onToggleSidebar={handleTogglePrimarySidebar}
          />
        ) : null}

        {showTuiTakeover ? (
          <>
            {tuiPanel}
            {isTerminalVisibleForSelectedThread && terminalPanel}
          </>
        ) : showTerminalTakeover ? (
          terminalPanel
        ) : (
          <>
        {selectedWorkspace ? (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">{t("app.empty.workspace.eyebrow")}</div>
              <h1>{selectedWorkspace.name}</h1>
              <p>{t("app.empty.workspace.body")}</p>
              <div className="empty-panel__actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
                >
                  {t("app.newThread")}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">{t("app.empty.noWorkspace.eyebrow")}</div>
              <h1>{t("app.empty.noWorkspace.title")}</h1>
              <p>{t("app.empty.noWorkspace.body")}</p>
            </div>
          </section>
        )}

        {terminalPanel}
          </>
        )}
        {showSystemPromptPanel ? (
          <SystemPromptPanel
            api={api}
            setSnapshot={setSnapshot}
            updateSnapshot={updateSnapshot}
          />
        ) : null}
        {showDiffPanel && selectedWorkspace && selectedSession ? (
          <DiffPanel
            workspaceId={selectedWorkspace.id}
            sessionId={selectedSession.id}
            api={api}
            sessionStatus={selectedSession.status}
            fileRequest={diffFileRequest}
          />
        ) : null}
      </main>

      {showSplitPanel && (
        <SplitPanel
          tabsManager={splitPanelTabs}
          visible={showSplitPanel}
          onTabClosed={handleSplitPanelTabClosed}
          onVisibilityChange={(visible) => {
            if (splitPanelWorkspaceId) {
              setSplitPanelWorkspaceKeys((cur) =>
                visible
                  ? setSessionKeyFlag(cur, splitPanelWorkspaceId)
                  : clearSessionKeyFlag(cur, splitPanelWorkspaceId),
              );
            }
          }}
          sidebarWidth={sidebarWidth}
          workspacePath={tuiWorkspace?.path ?? selectedWorkspace?.path ?? ""}
          workspace={tuiWorkspace ?? selectedWorkspace ?? null}
          cliEnablement={snapshot.cliEnablement}
          surfaceBgColor={snapshot.splitPanelBgColor}
        />
      )}
    </div>
  );
}

function buildTranscriptChangeMarker(sessionKey: string, transcript: readonly unknown[]): string {
  const lastItem = transcript.at(-1);
  return `${sessionKey}:${transcript.length}:${lastItem ? JSON.stringify(lastItem) : ""}`;
}

function isNearBottom(element: HTMLDivElement): boolean {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining < 32;
}
