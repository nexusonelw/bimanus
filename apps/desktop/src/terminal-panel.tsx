import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import stripAnsi from "strip-ansi";
import "@xterm/xterm/css/xterm.css";
import type { WorkspaceRecord } from "./desktop-state";
import { CloseIcon, MaximizeIcon, MinimizeIcon, PlusIcon, RefreshIcon } from "./icons";
import type { TerminalDataEvent, TerminalLaunchConfig, TerminalPanelSnapshot, TerminalSessionSnapshot, TerminalSize } from "./ipc";
import { isElectronHost } from "./platform-env";
import { useMobileBreakpoint } from "./use-mobile-breakpoint";
import { TerminalActionsMenu } from "./terminal-actions-menu";
import { installTerminalBlinkDecorator } from "./terminal-blink-decorator";
import { appendTerminalReplay } from "./terminal-model";
import { logTuiPerf, type TuiPerfLogContext } from "./tui-perf-log";
import { WorkspaceBindingIndicator } from "./split-panel/workspace-binding-indicator";
import type { ITheme } from "@xterm/xterm";
import { useI18n } from "./i18n";

const MIN_TERMINAL_HEIGHT = 220;
const DEFAULT_TERMINAL_HEIGHT = 340;
const PI_TUI_STARTUP_TIMEOUT_MS = 8_000;
// ponytail: terminal tab metadata may lag by 50ms; lower this only if UI chrome needs fresher replay state.
const TERMINAL_PANEL_STATE_FLUSH_MS = 50;

interface TerminalPanelProps {
  readonly workspace: WorkspaceRecord;
  readonly sessionId: string;
  readonly terminalScopeId?: string;
  readonly launchConfig?: TerminalLaunchConfig;
  readonly height: number;
  readonly isTakeover: boolean;
  readonly allowMultipleSessions?: boolean;
  readonly allowCreateSession?: boolean;
  /**
   * When true, the toolbar's "hide" button terminates the active terminal
   * session (instead of just hiding the panel). Note this does NOT close
   * the underlying session when the panel unmounts due to navigation -
   * pi-tui sessions are expected to keep running in the background and be
   * reattached later via the terminal service's session reuse + replay
   * buffer.
   */
  readonly closeOnHide?: boolean;
  readonly testId?: string;
  /**
   * 是否让终端容器与 xterm canvas 跟随应用明暗主题。
   * TUI 接管模式会自动开启；右侧分屏 CLI 可显式传入以与 TUI 视觉统一。
   * 常规集成终端（黑底控制台）不开启，保持默认暗色终端风格。
   */
  readonly adaptiveTheme?: boolean;
  /**
   * Optional light-theme surface background (hex). Injected as
   * `--surface-bg-custom` so adaptive CSS / xterm can pick it up without
   * overriding dark-theme tokens.
   */
  readonly surfaceBgColor?: string;
  /**
   * 工作区路径 — TUI 接管模式下用于在面板底部渲染工作目录指示器，
   * 与右侧分屏 CLI 的 WorkspaceBindingIndicator 对齐。
   * 非 TUI 模式下忽略。
   */
  readonly workspacePath?: string;
  /**
   * 仅在 TUI 接管模式下渲染于工具栏右侧的操作按钮插槽。
   * 用于将原先位于 Topbar 的 6 个全局切换按钮迁入 TUI header，
   * 同时避免 TerminalPanel 直接依赖全局状态。
   */
  readonly tuiHeaderActions?: ReactNode;
  readonly onHeightChange: (height: number) => void;
  readonly onToggleTakeover: () => void;
  readonly onHide: () => void | Promise<void>;
  readonly onActiveSessionChange?: (session: TerminalSessionSnapshot) => void | Promise<void>;
  readonly onSessionClosed?: (
    closedSession: TerminalSessionSnapshot,
    nextActiveSession: TerminalSessionSnapshot | undefined,
  ) => void | Promise<void>;
  /** Bumped by the shell when re-opening a hidden pi-tui session to force replay resync. */
  readonly reattachEpoch?: number;
  /**
   * 当为 true 时隐藏终端面板自身的工具栏（.terminal-panel__toolbar）。
   * 用于分屏嵌入模式 — 工具栏的控制按钮已上移至 SplitPanelToolbar。
   */
  readonly hideToolbar?: boolean;
  /**
   * 注册/注销当前终端的重启函数，供外部（如 SplitPanelToolbar）调用。
   * 传入 fn 表示注册，传入 null 表示注销（组件卸载时调用）。
   */
  readonly registerRestart?: (fn: (() => void) | null) => void;
  /**
   * 当前面板是否处于激活（可见）状态。默认 true，兼容非分屏的常规集成终端。
   * 分屏多 Tab 场景下，当此属性从 false 变为 true 时，组件会在下一帧
   * 主动调用 fitAndResize(true) 重新计算 cols/rows 并同步后端 PTY，
   * 避免 xterm.js 在不可见容器中累积的尺寸漂移导致渲染错乱。
   */
  readonly isActive?: boolean;
}

export function TerminalPanel({
  workspace,
  sessionId,
  terminalScopeId = sessionId,
  launchConfig,
  height,
  isTakeover,
  allowMultipleSessions = true,
  allowCreateSession = allowMultipleSessions,
  closeOnHide = false,
  testId = "integrated-terminal",
  adaptiveTheme = false,
  surfaceBgColor,
  workspacePath = "",
  tuiHeaderActions,
  onHeightChange,
  onToggleTakeover,
  onHide,
  onActiveSessionChange,
  onSessionClosed,
  reattachEpoch = 0,
  hideToolbar = false,
  registerRestart,
  isActive = true,
}: TerminalPanelProps) {
  const { t } = useI18n();
  const api = window.piApp;
  // TUI 接管模式：仅当 isTakeover 且 launchConfig.mode === "pi-tui" 时为真。
  // 用于挂载 .terminal-panel--tui 变体类，将 TUI 面板样式与右侧分屏 CLI 统一，
  // 同时避免污染常规集成终端（黑底控制台）的默认外观。
  const isTuiTakeover = isTakeover && launchConfig?.mode === "pi-tui";
  const isMobile = useMobileBreakpoint();
  // adaptiveTheme 显式开启，或 TUI 接管模式隐式开启，都会让终端外层容器与
  // xterm canvas 跟随应用明暗主题；常规集成终端保持默认暗色。
  const shouldAdaptTheme = adaptiveTheme || isTuiTakeover;
  const panelRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const webglAddonRef = useRef<Parameters<Terminal["loadAddon"]>[0] | null>(null);
  const terminalScrollFollowRef = useRef(new Map<string, boolean>());
  const activeTerminalIdRef = useRef("");
  // Incremented each time the xterm instance is (re-)created so that the
  // attach-session effect re-runs even when activeSession.id hasn't changed
  // (e.g. when navigating away and back to the same TUI session).
  const [xtermGeneration, setXtermGeneration] = useState(0);
  // Incremented each time a requestPanel call completes successfully. When the
  // terminal scope changes (e.g. switching TUI sessions) and then switches back
  // to the same session, activeSession.id stays the same but the replay buffer
  // may have grown. Bumping this epoch ensures the attach-session effect
  // re-runs and writes the up-to-date replay into the xterm instance.
  const [panelEpoch, setPanelEpoch] = useState(0);
  const lastSizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 });
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [panel, setPanel] = useState<TerminalPanelSnapshot | null>(null);
  const [error, setError] = useState<string>("");
  const panelSnapshotRef = useRef<TerminalPanelSnapshot | null>(null);
  const latestLaunchConfigRef = useRef(launchConfig);
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  const lastPanelRequestIdentityRef = useRef("");
  const terminalDataChunkCountRef = useRef(new Map<string, number>());
  const pendingTerminalDataRef = useRef(new Map<string, TerminalDataEvent[]>());
  const terminalDataFlushTimerRef = useRef<number | null>(null);
  const renderedTerminalSeqRef = useRef(new Map<string, number>());
  const tuiLogContextRef = useRef<TuiPerfLogContext | undefined>(undefined);
  const attachGenerationRef = useRef(0);
  const tuiStartupTimeoutRef = useRef<number | null>(null);
  const hasVisibleTerminalOutputRef = useRef(false);
  const replayAttachRef = useRef<{
    readonly terminalId: string;
    readonly generation: number;
    readonly snapshotSeq: number;
    replayFinished: boolean;
    pending: TerminalDataEvent[];
  } | null>(null);
  latestLaunchConfigRef.current = launchConfig;
  onActiveSessionChangeRef.current = onActiveSessionChange;

  const activeSession = useMemo(
    () => panel?.sessions.find((session) => session.id === panel.activeSessionId),
    [panel],
  );
  const activeSessionId = activeSession?.id ?? "";
  const activeSessionStatus = activeSession?.status ?? "";
  const activeSessionExitCode = activeSession?.exitCode;
  const activeSessionSignal = activeSession?.signal;
  const activeSessionHasReplay = hasMeaningfulTerminalReplay(activeSession?.replay ?? "");
  const visibleSessions = useMemo(
    () => allowMultipleSessions ? panel?.sessions ?? [] : activeSession ? [activeSession] : [],
    [activeSession, allowMultipleSessions, panel?.sessions],
  );
  const launchConfigKey = useMemo(() => terminalLaunchConfigKey(launchConfig), [launchConfig]);
  const tuiLogContext = useMemo<TuiPerfLogContext | undefined>(() => {
    if (launchConfig?.mode !== "pi-tui") {
      return undefined;
    }
    return {
      workspaceId: workspace.id,
      sessionId: launchConfig.sessionId ?? sessionId,
      traceId: launchConfig.debugTraceId,
    };
  }, [launchConfig, sessionId, workspace.id]);
  tuiLogContextRef.current = tuiLogContext;
  panelSnapshotRef.current = panel;
  const logTui = useCallback((phase: string, details: Record<string, unknown> = {}, terminalId?: string) => {
    const context = tuiLogContextRef.current;
    if (!context) {
      return;
    }
    logTuiPerf(phase, { ...context, terminalId }, {
      terminalScopeId,
      ...details,
    });
  }, [terminalScopeId]);

  // 从面板元素解析自适应主题下的 xterm 主题颜色。读取 .terminal-panel--adaptive
  // 作用域内定义的设计令牌（--bg-surface / --text-strong 等），确保 xterm canvas
  // 绘制区与外层 CSS 容器在明暗主题切换时保持一致，避免外层变浅/变暗但终端
  // 区仍是旧黑底。
  const resolveAdaptiveXtermTheme = useCallback((): ITheme => {
    const el = panelRef.current;
    const read = (name: string, fallback: string): string => {
      const value = el ? getComputedStyle(el).getPropertyValue(name).trim() : "";
      return value || fallback;
    };
    return {
      background: read("--bg-surface", "#F4FAFB"),
      foreground: read("--text-strong", "#111827"),
      cursor: read("--text-strong", "#111827"),
      selectionBackground: "rgba(99, 102, 241, 0.22)",
    };
  }, []);

  const flushPendingTerminalData = useCallback(() => {
    if (terminalDataFlushTimerRef.current !== null) {
      window.clearTimeout(terminalDataFlushTimerRef.current);
      terminalDataFlushTimerRef.current = null;
    }
    if (pendingTerminalDataRef.current.size === 0) {
      return;
    }
    const pendingByTerminal = pendingTerminalDataRef.current;
    pendingTerminalDataRef.current = new Map();
    setPanel((currentPanel) => {
      let nextPanel = currentPanel;
      for (const [terminalId, events] of pendingByTerminal) {
        nextPanel = updateSession(nextPanel, terminalId, (session) => {
          let replay = session.replay;
          let truncated = session.truncated;
          let seq = session.seq;
          for (const event of events) {
            if (event.seq <= seq) {
              continue;
            }
            const nextReplay = appendTerminalReplay(replay, event.data, truncated);
            replay = nextReplay.replay;
            truncated = nextReplay.truncated;
            seq = event.seq;
          }
          return { ...session, replay, truncated, seq };
        });
      }
      return nextPanel;
    });
  }, []);

  const queueTerminalDataForPanel = useCallback((event: TerminalDataEvent) => {
    const pending = pendingTerminalDataRef.current.get(event.terminalId) ?? [];
    pending.push(event);
    pendingTerminalDataRef.current.set(event.terminalId, pending);
    if (terminalDataFlushTimerRef.current === null) {
      terminalDataFlushTimerRef.current = window.setTimeout(flushPendingTerminalData, TERMINAL_PANEL_STATE_FLUSH_MS);
    }
  }, [flushPendingTerminalData]);

  const cancelPendingTerminalDataFlush = useCallback(() => {
    if (terminalDataFlushTimerRef.current !== null) {
      window.clearTimeout(terminalDataFlushTimerRef.current);
      terminalDataFlushTimerRef.current = null;
    }
    pendingTerminalDataRef.current.clear();
  }, []);

  useEffect(() => {
    if (error || launchConfig?.mode !== "pi-tui" || !activeSessionId) {
      return;
    }

    if (!activeSessionHasReplay && (activeSessionStatus === "exited" || activeSessionStatus === "error")) {
      setError(formatPiTuiStartupFailure(activeSessionExitCode, activeSessionSignal, t));
    }
  }, [activeSessionExitCode, activeSessionHasReplay, activeSessionId, activeSessionSignal, activeSessionStatus, error, launchConfig?.mode]);

  useEffect(() => {
    if (tuiStartupTimeoutRef.current !== null) {
      window.clearTimeout(tuiStartupTimeoutRef.current);
      tuiStartupTimeoutRef.current = null;
    }

    if (error || launchConfig?.mode !== "pi-tui" || !activeSessionId || hasVisibleTerminalOutputRef.current) {
      return;
    }

    const terminalId = activeSessionId;
    tuiStartupTimeoutRef.current = window.setTimeout(() => {
      const currentSession = panelSnapshotRef.current?.sessions.find((session) => session.id === terminalId);
      const visibleText = containerRef.current?.querySelector(".xterm-rows")?.textContent ?? "";
      if (
        !currentSession ||
        hasMeaningfulTerminalReplay(currentSession.replay) ||
        hasMeaningfulTerminalReplay(visibleText) ||
        hasVisibleTerminalOutputRef.current
      ) {
        return;
      }
      if (currentSession.status === "running" || currentSession.status === "exited" || currentSession.status === "error") {
        setError(t("terminal.timeout", { seconds: Math.round(PI_TUI_STARTUP_TIMEOUT_MS / 1000) }));
      }
    }, PI_TUI_STARTUP_TIMEOUT_MS);

    return () => {
      if (tuiStartupTimeoutRef.current !== null) {
        window.clearTimeout(tuiStartupTimeoutRef.current);
        tuiStartupTimeoutRef.current = null;
      }
    };
  }, [activeSessionHasReplay, activeSessionId, activeSessionStatus, error, launchConfig?.mode]);

  const requestPanel = useCallback(async () => {
    if (!api) {
      return null;
    }
    logTui("renderer.terminal.ensurePanel.start", {
      size: lastSizeRef.current,
      launchConfig: latestLaunchConfigRef.current,
      launchConfigKey,
    });
    const nextPanel = await api.ensureTerminalPanel(workspace.id, terminalScopeId, lastSizeRef.current, latestLaunchConfigRef.current);
    logTui("renderer.terminal.ensurePanel.done", {
      activeTerminalId: nextPanel?.activeSessionId,
      sessionCount: nextPanel?.sessions.length ?? 0,
      statuses: nextPanel?.sessions.map((session) => `${session.id}:${session.status}`) ?? [],
    }, nextPanel?.activeSessionId);
    return nextPanel;
  }, [api, launchConfigKey, logTui, terminalScopeId, workspace.id]);

  useEffect(() => {
    let active = true;
    const panelRequestIdentity = `${workspace.id}\0${terminalScopeId}`;
    const workspaceOrScopeChanged = lastPanelRequestIdentityRef.current !== panelRequestIdentity;
    lastPanelRequestIdentityRef.current = panelRequestIdentity;
    if (workspaceOrScopeChanged) {
      setPanel(null);
    }
    setError("");
    void requestPanel()
      .then((nextPanel) => {
        if (!active || !nextPanel) {
          return;
        }
        setPanel(nextPanel);
        setError("");
        const nextActiveSession = nextPanel.sessions.find((session) => session.id === nextPanel.activeSessionId);
        if (nextActiveSession) {
          void onActiveSessionChangeRef.current?.(nextActiveSession);
        }
        // Always bump the epoch so that the attach-session effect re-runs
        // after every successful panel fetch. This is important when switching
        // TUI sessions and returning to the same one: activeSession.id hasn't
        // changed, but the replay buffer has grown during the detached period.
        setPanelEpoch((e) => e + 1);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      active = false;
    };
  }, [requestPanel, reattachEpoch]);

  const createTerminal = useCallback(async (nextLaunchConfig = latestLaunchConfigRef.current) => {
    if (!api) {
      return;
    }
    logTui("renderer.terminal.createSession.start", {
      size: lastSizeRef.current,
      launchConfig: nextLaunchConfig,
    });
    const nextPanel = await api.createTerminalSession(workspace.id, terminalScopeId, lastSizeRef.current, nextLaunchConfig);
    logTui("renderer.terminal.createSession.done", {
      activeTerminalId: nextPanel.activeSessionId,
      sessionCount: nextPanel.sessions.length,
    }, nextPanel.activeSessionId);
    setPanel(nextPanel);
    return nextPanel;
  }, [api, logTui, terminalScopeId, workspace.id]);

  const setActiveTerminal = useCallback(async (terminalId: string) => {
    if (!api) {
      return;
    }
    logTui("renderer.terminal.setActive.start", { terminalId }, terminalId);
    const nextPanel = await api.setActiveTerminalSession(workspace.id, terminalScopeId, terminalId);
    logTui("renderer.terminal.setActive.done", {
      activeTerminalId: nextPanel.activeSessionId,
      sessionCount: nextPanel.sessions.length,
    }, nextPanel.activeSessionId);
    setPanel(nextPanel);
    const nextActiveSession = nextPanel.sessions.find((session) => session.id === nextPanel.activeSessionId);
    if (nextActiveSession) {
      void onActiveSessionChange?.(nextActiveSession);
    }
  }, [api, onActiveSessionChange, terminalScopeId, workspace.id]);

  const closeTerminal = useCallback(async (terminalId: string) => {
    if (!api) {
      return;
    }
    const closedSession = panel?.sessions.find((session) => session.id === terminalId);
    const nextPanel = await api.closeTerminalSession(terminalId);
    const nextActiveSession = nextPanel?.sessions.find((session) => session.id === nextPanel.activeSessionId);
    if (closedSession) {
      void onSessionClosed?.(closedSession, nextActiveSession);
    }
    if (nextPanel) {
      setPanel(nextPanel);
      if (nextActiveSession) {
        void onActiveSessionChange?.(nextActiveSession);
      }
    } else {
      setPanel(null);
      await onHide();
    }
  }, [api, onActiveSessionChange, onHide, onSessionClosed, panel?.sessions]);

  const restartTerminal = useCallback(async (nextLaunchConfig = launchConfig) => {
    if (!api || !activeSession) {
      return;
    }
    logTui("renderer.terminal.restart.start", {
      terminalId: activeSession.id,
      nextLaunchConfig,
      size: lastSizeRef.current,
    }, activeSession.id);
    const nextPanel = await api.restartTerminalSession(activeSession.id, lastSizeRef.current, nextLaunchConfig);
    terminalRef.current?.reset();
    renderedTerminalSeqRef.current.delete(activeSession.id);
    setPanel(nextPanel);
    setPanelEpoch((e) => e + 1);
    logTui("renderer.terminal.restart.done", {
      activeTerminalId: nextPanel.activeSessionId,
      sessionCount: nextPanel.sessions.length,
    }, nextPanel.activeSessionId);
  }, [activeSession, api, launchConfig, logTui]);

  // 保持最新 restartTerminal 引用，供外部经 registerRestart 调用时使用。
  // 避免每次 restartTerminal 重建就重新注册（registerRestart 是稳定的）。
  const restartTerminalRef = useRef(restartTerminal);
  restartTerminalRef.current = restartTerminal;

  useEffect(() => {
    if (!registerRestart) {
      return;
    }
    registerRestart(() => {
      void restartTerminalRef.current();
    });
    return () => {
      registerRestart(null);
    };
  }, [registerRestart]);

  const fitAndResize = useCallback((force = false) => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const terminalId = activeTerminalIdRef.current;
    if (!api || !terminalId || !terminal || !fitAddon || !containerRef.current) {
      return;
    }
    fitAddon.fit();
    const nextSize = { cols: terminal.cols, rows: terminal.rows };
    if (!force && nextSize.cols === lastSizeRef.current.cols && nextSize.rows === lastSizeRef.current.rows) {
      return;
    }
    lastSizeRef.current = nextSize;
    void api.resizeTerminal(terminalId, nextSize, force);
  }, [api]);

  useEffect(() => {
    const panelElement = panelRef.current;
    if (!api || !panelElement) {
      return undefined;
    }
    const markFocused = () => {
      void api.setTerminalFocused(true);
    };
    const markBlurred = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && panelElement.contains(event.relatedTarget)) {
        return;
      }
      void api.setTerminalFocused(false);
    };
    panelElement.addEventListener("focusin", markFocused);
    panelElement.addEventListener("focusout", markBlurred);
    return () => {
      panelElement.removeEventListener("focusin", markFocused);
      panelElement.removeEventListener("focusout", markBlurred);
      void api.setTerminalFocused(false);
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    const removeData = api.onTerminalData((event) => {
      const nextCount = (terminalDataChunkCountRef.current.get(event.terminalId) ?? 0) + 1;
      terminalDataChunkCountRef.current.set(event.terminalId, nextCount);
      if (shouldLogTerminalDataChunk(nextCount)) {
        logTui("renderer.terminal.data", {
          chunkIndex: nextCount,
          bytes: event.data.length,
          preview: event.data.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").slice(0, 120),
        }, event.terminalId);
      }
      if (hasMeaningfulTerminalReplay(event.data)) {
        hasVisibleTerminalOutputRef.current = true;
      }
      queueTerminalDataForPanel(event);
      if (event.terminalId === activeTerminalIdRef.current) {
        const replayAttach = replayAttachRef.current;
        if (replayAttach?.terminalId === event.terminalId) {
          if (!replayAttach.replayFinished) {
            replayAttach.pending.push(event);
            return;
          }
          const renderedSeq = renderedTerminalSeqRef.current.get(event.terminalId) ?? 0;
          if (event.seq <= renderedSeq) {
            return;
          }
        }
        terminalRef.current?.write(event.data);
        renderedTerminalSeqRef.current.set(
          event.terminalId,
          Math.max(renderedTerminalSeqRef.current.get(event.terminalId) ?? 0, event.seq),
        );
      }
    });
    const removeExit = api.onTerminalExit((event) => {
      logTui("renderer.terminal.exit", {
        exitCode: event.exitCode,
        signal: event.signal,
      }, event.terminalId);
      const activeTerminalId = activeTerminalIdRef.current;
      const activePanelTerminalId = panelSnapshotRef.current?.activeSessionId;
      const hasRenderedOutput = hasVisibleTerminalOutputRef.current || hasMeaningfulTerminalReplay(
        panelSnapshotRef.current?.sessions.find((session) => session.id === event.terminalId)?.replay ?? "",
      );
      if (
        launchConfig?.mode === "pi-tui" &&
        (event.terminalId === activeTerminalId || event.terminalId === activePanelTerminalId) &&
        !hasRenderedOutput
      ) {
        setError(formatPiTuiStartupFailure(event.exitCode, event.signal, t));
      }
      flushPendingTerminalData();
      setPanel((currentPanel) => updateSession(currentPanel, event.terminalId, (session) => ({
        ...session,
        status: "exited",
        exitCode: event.exitCode,
        signal: event.signal,
      })));
    });
    const removeError = api.onTerminalError((event) => {
      logTui("renderer.terminal.error", {
        message: event.message,
      }, event.terminalId);
      const activeTerminalId = activeTerminalIdRef.current;
      const activePanelTerminalId = panelSnapshotRef.current?.activeSessionId;
      const hasRenderedOutput = hasVisibleTerminalOutputRef.current || hasMeaningfulTerminalReplay(
        panelSnapshotRef.current?.sessions.find((session) => session.id === event.terminalId)?.replay ?? "",
      );
      if (
        launchConfig?.mode === "pi-tui" &&
        (event.terminalId === activeTerminalId || event.terminalId === activePanelTerminalId) &&
        !hasRenderedOutput
      ) {
        setError(event.message);
      }
      flushPendingTerminalData();
      setPanel((currentPanel) => updateSession(currentPanel, event.terminalId, (session) => ({
        ...session,
        status: "error",
        ...appendTerminalReplay(session.replay, `${event.message}\r\n`, session.truncated),
      })));
    });
    return () => {
      removeData();
      removeExit();
      removeError();
      cancelPendingTerminalDataFlush();
    };
  }, [api, cancelPendingTerminalDataFlush, flushPendingTerminalData, logTui, queueTerminalDataForPanel]);

  useEffect(() => {
    const container = containerRef.current;
    if (!api || !container) {
      return undefined;
    }

    logTui("renderer.terminal.xterm.create.start");
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      scrollback: 1_000_000,
      theme: shouldAdaptTheme
        ? resolveAdaptiveXtermTheme()
        : {
            background: "#0f1117",
            foreground: "#d7dae0",
            cursor: "#f2f4f8",
            selectionBackground: "#39557a",
          },
    });
    const fitAddon = new FitAddon();
    const clipboardAddon = new ClipboardAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      void api.openExternal(uri);
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(clipboardAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const commandModifier = api.platform === "darwin" ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (api.platform !== "darwin" && isTerminalPasteShortcut(event)) {
        void pasteClipboardTextIntoTerminal(terminal, api);
        return false;
      }
      if (allowCreateSession && commandModifier && !event.shiftKey && key === "t") {
        void createTerminal();
        return false;
      }
      if (api.platform === "darwin" && event.metaKey) {
        const sequence = macTerminalSequenceForEvent(event);
        const terminalId = activeTerminalIdRef.current;
        if (sequence && terminalId) {
          void api.writeTerminal(terminalId, sequence);
          return false;
        }
      }
      return true;
    });
    terminal.onData((data) => {
      const terminalId = activeTerminalIdRef.current;
      if (terminalId) {
        void api.writeTerminal(terminalId, data);
      }
    });
    terminal.onTitleChange((title) => {
      const terminalId = activeTerminalIdRef.current;
      if (!terminalId) {
        return;
      }
      void api.setTerminalTitle(terminalId, title);
      setPanel((currentPanel) => updateSession(currentPanel, terminalId, (session) => ({
        ...session,
        title: title.trim() || session.title,
      })));
    });
    const scrollDisposable = terminal.onScroll(() => {
      const terminalId = activeTerminalIdRef.current;
      if (terminalId) {
        terminalScrollFollowRef.current.set(terminalId, isTerminalScrolledToBottom(terminal));
      }
    });
    terminal.open(container);
    let touchStart: { x: number; y: number } | null = null;
    let touchLastY = 0;
    let touchAxis: "horizontal" | "vertical" | null = null;
    let touchRemainder = 0;
    const resetTouchScroll = () => {
      touchStart = null;
      touchAxis = null;
      touchRemainder = 0;
    };
    const handleTouchPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary || !window.matchMedia("(max-width: 768px)").matches) {
        return;
      }
      touchStart = { x: event.clientX, y: event.clientY };
      touchLastY = event.clientY;
      touchAxis = null;
      touchRemainder = 0;
    };
    const handleTouchPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary || !touchStart) {
        return;
      }
      if (!touchAxis) {
        const deltaX = Math.abs(event.clientX - touchStart.x);
        const deltaY = Math.abs(event.clientY - touchStart.y);
        if (Math.max(deltaX, deltaY) < 6) {
          return;
        }
        touchAxis = deltaY > deltaX ? "vertical" : "horizontal";
      }
      if (touchAxis !== "vertical") {
        return;
      }
      event.preventDefault();
      const rowHeight = Math.max(1, container.clientHeight / terminal.rows);
      touchRemainder += touchLastY - event.clientY;
      touchLastY = event.clientY;
      const rows = Math.trunc(touchRemainder / rowHeight);
      if (rows !== 0) {
        // ponytail: scrollback only; synthesize wheel events if alternate-buffer CLIs need touch scrolling.
        terminal.scrollLines(rows);
        touchRemainder -= rows * rowHeight;
      }
    };
    container.addEventListener("pointerdown", handleTouchPointerDown);
    container.addEventListener("pointermove", handleTouchPointerMove, { passive: false });
    container.addEventListener("pointerup", resetTouchScroll);
    container.addEventListener("pointercancel", resetTouchScroll);
    const webglAddon = loadTerminalWebglAddon(terminal, logTui);
    webglAddonRef.current = webglAddon;
    const handleContextMenu = (event: MouseEvent) => {
      const selectedText = terminal.getSelection();
      if (!selectedText.trim()) {
        return;
      }

      // Only suppress the browser's native context menu inside Electron, where
      // the main process provides a native copy menu. In remote-UI (browser)
      // mode we fall through so the browser's own menu remains available.
      if (!isElectronHost()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void api
        .showCopySelectionContextMenu({
          selectedText,
          x: event.clientX,
          y: event.clientY,
        })
        .then((copied) => {
          if (copied) {
            terminal.clearSelection();
          }
        })
        .catch((error: unknown) => {
          console.error("Unable to show terminal context menu:", error);
        });
    };
    container.addEventListener("contextmenu", handleContextMenu, { capture: true });
    terminal.focus();
    const blinkDecorator = installTerminalBlinkDecorator(terminal, container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    logTui("renderer.terminal.xterm.opened", {
      cols: terminal.cols,
      rows: terminal.rows,
    });
    // Tell the attach-session effect that a fresh xterm instance is ready so
    // it re-runs even when activeSession.id hasn't changed (e.g. when the user
    // navigates away and back to the same TUI session).
    setXtermGeneration((g) => g + 1);
    // Force-resize retries to handle Pty startup race condition: the child
    // process may not yet be listening for SIGWINCH when the first resize
    // signal is sent, causing the terminal to remain at default 80x24 size.
    const retryTimers = [150, 500, 1000].map((delay) =>
      setTimeout(() => fitAndResize(true), delay),
    );

    let resizeFrame: number | null = null;
    const scheduleFitAndResize = () => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAndResize();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFitAndResize);
    resizeObserver.observe(container);

    return () => {
      retryTimers.forEach(clearTimeout);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      container.removeEventListener("contextmenu", handleContextMenu, true);
      container.removeEventListener("pointerdown", handleTouchPointerDown);
      container.removeEventListener("pointermove", handleTouchPointerMove);
      container.removeEventListener("pointerup", resetTouchScroll);
      container.removeEventListener("pointercancel", resetTouchScroll);
      resizeObserver.disconnect();
      scrollDisposable.dispose();
      blinkDecorator.dispose();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      terminalRef.current = null;
      activeTerminalIdRef.current = "";
      terminal.dispose();
    };
  }, [allowCreateSession, api, createTerminal, fitAndResize, logTui]);

  // 自适应主题模式下，监听 documentElement 的 class 变化（:root.dark 切换）以及
  // surfaceBgColor 变更以同步 xterm canvas 主题。CSS 只改外层 DOM，xterm 的绘制区
  // 需通过 options.theme 重置，否则明暗切换 / 背景色切换时终端区会保留旧底色。
  // TUI 接管模式与右侧分屏 CLI 共用。
  useEffect(() => {
    if (!shouldAdaptTheme) {
      return;
    }
    const applyTheme = () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      terminal.options.theme = resolveAdaptiveXtermTheme();
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
      });
    };
    applyTheme();
    const observer = new MutationObserver(() => applyTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [shouldAdaptTheme, resolveAdaptiveXtermTheme, surfaceBgColor]);

  // ── Tab 激活时主动 refit ──
  // 分屏多 Tab 场景下，切换 Tab 仅改变 CSS 可见性而不卸载组件。xterm.js
  // 在不可见容器中无法正确计算画布尺寸，切回可见时若不主动触发 fit，
  // 终端会保留旧渲染状态，表现为背景乱、字符错位、TUI 花屏。
  useEffect(() => {
    if (!isActive) {
      return;
    }
    let cancelled = false;
    // 等待两帧：确保浏览器完成 display 切换与 reflow，xterm canvas 容器
    // 拿到最终物理尺寸后再 fit。在隐藏状态（offsetWidth 为 0）下调用
    // fitAddon.fit() 会计算出 0×0 的错误尺寸。
    window.requestAnimationFrame(() => {
      if (cancelled) return;
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        const container = containerRef.current;
        if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
          return;
        }
        fitAndResize(true);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, fitAndResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !activeSession) {
      return;
    }

    const generation = attachGenerationRef.current + 1;
    attachGenerationRef.current = generation;
    const replayAttach: NonNullable<typeof replayAttachRef.current> = {
      terminalId: activeSession.id,
      generation,
      snapshotSeq: activeSession.seq,
      replayFinished: false,
      pending: [],
    };
    replayAttachRef.current = replayAttach;
    activeTerminalIdRef.current = activeSession.id;
    hasVisibleTerminalOutputRef.current = hasMeaningfulTerminalReplay(activeSession.replay);
    const forceFullReplayAttach = launchConfig?.mode === "pi-tui";
    if (forceFullReplayAttach) {
      renderedTerminalSeqRef.current.delete(activeSession.id);
    } else if ((renderedTerminalSeqRef.current.get(activeSession.id) ?? -1) >= activeSession.seq) {
      replayAttach.replayFinished = true;
      terminal.focus();
      return;
    }
    logTui("renderer.terminal.xterm.attachSession", {
      activeTerminalId: activeSession.id,
      replayLength: activeSession.replay.length,
      snapshotSeq: activeSession.seq,
      status: activeSession.status,
      forceFullReplayAttach,
      reattachEpoch,
    }, activeSession.id);
    const shouldFollowOutputAfterReplay = terminalScrollFollowRef.current.get(activeSession.id) ?? true;
    terminal.reset();
    terminal.focus();
    fitAndResize(true);

    const finishReplay = () => {
      if (replayAttachRef.current !== replayAttach || attachGenerationRef.current !== generation) {
        return;
      }
      replayAttach.replayFinished = true;
      const pending = replayAttach.pending;
      replayAttach.pending = [];
      let renderedSeq = activeSession.seq;
      for (const event of pending) {
        if (event.seq > activeSession.seq) {
          terminal.write(event.data);
          renderedSeq = Math.max(renderedSeq, event.seq);
        }
      }
      renderedTerminalSeqRef.current.set(activeSession.id, renderedSeq);
      if (shouldFollowOutputAfterReplay) {
        terminal.scrollToBottom();
        terminalScrollFollowRef.current.set(activeSession.id, true);
      } else {
        terminalScrollFollowRef.current.set(activeSession.id, false);
      }
      logTui("renderer.terminal.fit.firstAnimationFrame", {
        terminalId: activeSession.id,
        pendingCount: pending.length,
      }, activeSession.id);
      window.requestAnimationFrame(() => {
        fitAndResize();
      });
    };

    if (activeSession.replay) {
      terminal.write(activeSession.replay, finishReplay);
    } else {
      finishReplay();
    }

    return () => {
      if (replayAttachRef.current === replayAttach) {
        replayAttach.replayFinished = true;
        replayAttach.pending = [];
      }
    };
  }, [activeSession?.id, launchConfig?.mode, panelEpoch, reattachEpoch, xtermGeneration, fitAndResize, logTui]);

  const hidePanel = useCallback(() => {
    if (closeOnHide && activeSession) {
      void closeTerminal(activeSession.id);
      return;
    }
    void onHide();
  }, [activeSession, closeOnHide, closeTerminal, onHide]);

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startY = event.clientY;
    const startHeight = containerRef.current?.closest<HTMLElement>(".terminal-panel")?.offsetHeight ?? height;
    const maxHeight = Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - 140);

    const handleMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.min(maxHeight, Math.max(MIN_TERMINAL_HEIGHT, startHeight + startY - moveEvent.clientY));
      onHeightChange(nextHeight);
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      resizeCleanupRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    resizeCleanupRef.current = handleUp;
  };

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      cancelPendingTerminalDataFlush();
    };
  }, [cancelPendingTerminalDataFlush]);

  const panelStyle = {
    ...(isTakeover ? {} : { height: `${height || DEFAULT_TERMINAL_HEIGHT}px` }),
    ...(shouldAdaptTheme && surfaceBgColor
      ? ({ "--surface-bg-custom": surfaceBgColor } as CSSProperties)
      : {}),
  };

  return (
    <section
      ref={panelRef}
      className={[
        "terminal-panel",
        isTakeover ? "terminal-panel--takeover" : null,
        shouldAdaptTheme ? "terminal-panel--adaptive" : null,
        isTuiTakeover ? "terminal-panel--tui" : null,
        hideToolbar ? "terminal-panel--no-toolbar" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      data-pi-terminal="true"
      data-session-id={sessionId}
      data-terminal-scope-id={terminalScopeId}
      data-testid={testId}
      style={Object.keys(panelStyle).length > 0 ? panelStyle : undefined}
    >
      <div className="terminal-panel__resize-handle" onMouseDown={startResize} />
      {!hideToolbar ? (
      <div className="terminal-panel__toolbar">
        {allowMultipleSessions ? (
          <div className="terminal-panel__tabs" role="tablist" aria-label={t("terminal.sessions")}>
            {visibleSessions.map((session) => (
              <div
                key={session.id}
                className={`terminal-panel__tab-item${session.id === panel?.activeSessionId ? " terminal-panel__tab-item--active" : ""}`}
              >
                <button
                  className="terminal-panel__tab"
                  type="button"
                  role="tab"
                  aria-selected={session.id === panel?.activeSessionId}
                  data-testid="terminal-tab"
                  onClick={() => void setActiveTerminal(session.id)}
                >
                  <span className={`terminal-panel__status terminal-panel__status--${session.status}`} />
                  <span className="terminal-panel__tab-title">{session.title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-panel__tab-close"
                  aria-label={t("terminal.closeSession", { name: session.title })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTerminal(session.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {isMobile ? (
          <TerminalActionsMenu>
            {allowCreateSession ? (
              <button type="button" className="terminal-panel__dropdown-item" title={t("terminal.new")} aria-label={t("terminal.new")} role="menuitem" onClick={() => void createTerminal()}>
                <PlusIcon />
                <span>{t("terminal.new")}</span>
              </button>
            ) : null}
            <button type="button" className="terminal-panel__dropdown-item" title={t("terminal.restart")} aria-label={t("terminal.restart")} role="menuitem" onClick={() => void restartTerminal()}>
              <RefreshIcon />
              <span>{t("terminal.restart")}</span>
            </button>
            {allowMultipleSessions ? (
              <button
                type="button"
                className="terminal-panel__dropdown-item"
                title={isTakeover ? t("terminal.restore") : t("terminal.maximize")}
                aria-label={isTakeover ? t("terminal.restore") : t("terminal.maximize")}
                role="menuitem"
                onClick={onToggleTakeover}
              >
                {isTakeover ? <MinimizeIcon /> : <MaximizeIcon />}
                <span>{isTakeover ? t("terminal.restore") : t("terminal.maximize")}</span>
              </button>
            ) : null}
            <button type="button" className="terminal-panel__dropdown-item" title={t("terminal.hide")} aria-label={t("terminal.hide")} role="menuitem" onClick={hidePanel}>
              <CloseIcon />
              <span>{t("terminal.hide")}</span>
            </button>
            {isTuiTakeover && tuiHeaderActions ? (
              <>
                <div className="terminal-panel__dropdown-divider" />
                <div className="terminal-panel__dropdown-header-actions">{tuiHeaderActions}</div>
              </>
            ) : null}
          </TerminalActionsMenu>
        ) : (
        <div className="terminal-panel__actions">
          {allowCreateSession ? (
            <button type="button" className="icon-button terminal-panel__action" title={t("terminal.new")} aria-label={t("terminal.new")} onClick={() => void createTerminal()}>
              <PlusIcon />
            </button>
          ) : null}
          <button type="button" className="icon-button terminal-panel__action" title={t("terminal.restart")} aria-label={t("terminal.restart")} onClick={() => void restartTerminal()}>
            <RefreshIcon />
          </button>
          {allowMultipleSessions ? (
            <button
              type="button"
              className="icon-button terminal-panel__action"
              title={isTakeover ? t("terminal.restore") : t("terminal.maximize")}
              aria-label={isTakeover ? t("terminal.restore") : t("terminal.maximize")}
              onClick={onToggleTakeover}
            >
              {isTakeover ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>
          ) : null}
          <button type="button" className="icon-button terminal-panel__action" title={t("terminal.hide")} aria-label={t("terminal.hide")} onClick={hidePanel}>
            <CloseIcon />
          </button>
          {isTuiTakeover && tuiHeaderActions ? (
            <div className="terminal-panel__global-actions">
              <div className="terminal-panel__actions-divider" />
              {tuiHeaderActions}
            </div>
          ) : null}
        </div>
        )}
      </div>
      ) : null}
      {error ? (
        <div className="terminal-panel__error">{error}</div>
      ) : (
        <div className="terminal-panel__viewport" ref={containerRef} />
      )}
      {/* TUI 接管模式底部工作目录指示器 — 与右侧分屏 CLI 的
          WorkspaceBindingIndicator 对齐，将路径信息从顶部下移到底部展示。
          仅在 TUI 模式且有工作区路径时渲染。 */}
      {isTuiTakeover && workspacePath ? (
        <WorkspaceBindingIndicator
          bindingMode={{ kind: "follow-workspace" }}
          currentPath={workspacePath}
          detailed={true}
        />
      ) : null}
    </section>
  );
}

type TerminalAddon = Parameters<Terminal["loadAddon"]>[0];

function loadTerminalWebglAddon(
  terminal: Terminal,
  logTui: (phase: string, details?: Record<string, unknown>, terminalId?: string) => void,
): TerminalAddon | null {
  try {
    const webglAddon = new WebglAddon();
    terminal.loadAddon(webglAddon);
    logTui("renderer.terminal.webgl.enabled");
    return webglAddon;
  } catch (error: unknown) {
    logTui("renderer.terminal.webgl.unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function isTerminalScrolledToBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY - 1;
}

function updateSession(
  panel: TerminalPanelSnapshot | null,
  terminalId: string,
  update: (session: TerminalSessionSnapshot) => TerminalSessionSnapshot,
): TerminalPanelSnapshot | null {
  if (!panel) {
    return panel;
  }
  return {
    ...panel,
    sessions: panel.sessions.map((session) => session.id === terminalId ? update(session) : session),
  };
}

function terminalLaunchConfigKey(config: TerminalLaunchConfig | undefined): string {
  if (!config) {
    return "none";
  }
  if (config.mode === "pi-tui") {
    return [
      "pi-tui",
      config.sessionId ?? "",
      config.newSessionKey ?? "",
      config.newSessionId ?? "",
      config.debugTraceId ?? "",
    ].join(":");
  }
  return config.mode;
}

function formatPiTuiStartupFailure(
  exitCode: number | undefined,
  signal: number | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const details: string[] = [];
  if (exitCode !== undefined) {
    details.push(t("terminal.exitCode", { code: exitCode }));
  }
  if (signal !== undefined) {
    details.push(t("terminal.signal", { signal }));
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return t("terminal.exitedNoOutput", { suffix });
}

function shouldLogTerminalDataChunk(chunkIndex: number): boolean {
  return chunkIndex <= 8 || chunkIndex === 10 || chunkIndex === 15 || chunkIndex === 20 || chunkIndex % 25 === 0;
}

function hasMeaningfulTerminalReplay(replay: string): boolean {
  return stripAnsi(replay).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().length > 0;
}

function isTerminalPasteShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (event.ctrlKey && key === "v") || (event.shiftKey && event.key === "Insert");
}

async function pasteClipboardTextIntoTerminal(terminal: Terminal, api: NonNullable<typeof window.piApp>): Promise<void> {
  const text = await api.readClipboardText();
  if (text) {
    terminal.paste(text);
  }
}

function macTerminalSequenceForEvent(event: KeyboardEvent): string | undefined {
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      return "\x01";
    case "ArrowRight":
    case "ArrowDown":
      return "\x05";
    case "Backspace":
      return "\x15";
    case "Delete":
      return "\x0b";
    default:
      return undefined;
  }
}
