import type { HostUiRequest, SessionConfig } from "@bimanus/session-driver";
import type { ModelSettingsSnapshot, RuntimeCommandRecord, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import { createDefaultCliEnablement } from "./cli-enablement";
export type SessionStatus = "idle" | "running" | "failed";

export type AppView = "threads" | "new-thread" | "skills" | "extensions" | "settings";
export type WorkspaceKind = "primary" | "worktree";
export type WorktreeStatus = "ready" | "missing" | "error";
export type NewThreadEnvironment = "local" | "worktree";
export type ThemeMode = "system" | "light" | "dark";
export type LocaleSetting = "auto" | "en" | "zh";
export type ResolvedLocale = "en" | "zh";

/** Normalize an arbitrary value into a valid LocaleSetting, defaulting to "auto". */
export function normalizeLocale(value: unknown): LocaleSetting {
  if (value === "en" || value === "zh" || value === "auto") return value;
  return "auto";
}

/**
 * Resolve the concrete locale to use for translations.
 * When setting is "auto", detect from navigator.language (zh* → zh, else en).
 */
export function resolveLocale(setting: LocaleSetting): ResolvedLocale {
  if (setting === "en" || setting === "zh") return setting;
  if (typeof navigator !== "undefined") {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) return "zh";
  }
  return "en";
}

/** Default pastel surface used by TUI / split panel (Chinese color 淡青). */
export const DEFAULT_SURFACE_BG_COLOR = "#F4FAFB";

export interface SurfaceBgColorOption {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly description: string;
}

/**
 * Soft Chinese-color presets for TUI / split-panel backgrounds.
 * Kept intentionally high-key (near-white pastels) so long terminal sessions
 * stay airy instead of looking like solid tinted cards.
 */
export const SURFACE_BG_COLOR_OPTIONS: readonly SurfaceBgColorOption[] = [
  // Cyan / 青 family first — closest to the original Mac vibrancy tint.
  { id: "danqing", label: "淡青", value: "#F4FAFB", description: "极淡的湖水青" },
  { id: "tianqing", label: "天青", value: "#F3F8FC", description: "晴空般的浅天青" },
  { id: "shuiqing", label: "水色", value: "#F2F9FB", description: "清水映天的微青" },
  { id: "canglang", label: "沧浪", value: "#F1F8FA", description: "沧浪之水的浅青" },
  { id: "qianpanshui", label: "浅泮水", value: "#F3FAFC", description: "轻盈近白的浅水蓝" },
  { id: "piaoqing", label: "缥青", value: "#F2F8F7", description: "丝绢般的缥缈青" },
  { id: "biqing", label: "碧青", value: "#F1F8F6", description: "玉石微光的淡碧青" },
  { id: "qingbai", label: "青白", value: "#F4F9F8", description: "青中带白的极淡色" },
  { id: "yadanqing", label: "鸭蛋青", value: "#F2F8F5", description: "偏粉调的天然玉青" },
  { id: "ailv", label: "艾绿", value: "#F3F8F6", description: "草木微带霜华" },
  // Soft neutrals / warm pastels
  { id: "yuese", label: "月白", value: "#F3F7F9", description: "月下清淡的蓝白" },
  { id: "shuangse", label: "霜色", value: "#F6F7F8", description: "冰霜般的冷灰白" },
  { id: "xingbai", label: "杏白", value: "#FCF8F3", description: "微温温润的暖白黄" },
  { id: "ouse", label: "藕色", value: "#FAF5F7", description: "温雅淡雅的肉粉藕荷" },
] as const;

/** Older preset hex values remapped when the palette was lightened. */
const LEGACY_SURFACE_BG_COLOR_MAP: Readonly<Record<string, string>> = {
  "#e6f3f5": "#F4FAFB", // 淡青
  "#e2ece9": "#F3F8F6", // 艾绿
  "#e8f4f8": "#F3FAFC", // 浅泮水
  "#e0eee8": "#F2F8F5", // 鸭蛋青
  "#faf4eb": "#FCF8F3", // 杏白
  "#f4ecef": "#FAF5F7", // 藕色
  "#e9ebec": "#F6F7F8", // 霜色
  "#d6e4e8": "#F3F7F9", // 月白
};

const SURFACE_BG_COLOR_SET = new Set(
  SURFACE_BG_COLOR_OPTIONS.map((option) => option.value.toLowerCase()),
);

/** Accept a preset or any valid #RGB / #RRGGBB / #RRGGBBAA hex color. */
export function normalizeSurfaceBgColor(
  value: unknown,
  fallback: string = DEFAULT_SURFACE_BG_COLOR,
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    const legacy = LEGACY_SURFACE_BG_COLOR_MAP[lower];
    if (legacy) {
      return legacy;
    }
    // Prefer canonical casing from the preset list when the value matches one.
    const preset = SURFACE_BG_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === lower);
    return preset?.value ?? trimmed.toUpperCase();
  }
  return fallback;
}

export function isKnownSurfaceBgColor(value: string): boolean {
  return SURFACE_BG_COLOR_SET.has(value.trim().toLowerCase());
}

// 降低默认值以减少并发 PTY 子进程的 CPU 竞争
// TODO: 未来可基于 CPU 核心数动态调整：Math.max(2, Math.floor(os.cpus().length / 2))
export const DEFAULT_TUI_TAB_LIMIT = 8;
export const MIN_TUI_TAB_LIMIT = 1;
export const MAX_TUI_TAB_LIMIT = 50;
export const DEFAULT_REMOTE_UI_PORT = 43174;
export const MIN_REMOTE_UI_PORT = 0;
export const MAX_REMOTE_UI_PORT = 65535;
export const DEFAULT_SIDEBAR_WIDTH = 292;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 600;

export function normalizeTuiTabLimit(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_TUI_TAB_LIMIT;
  }
  return Math.min(MAX_TUI_TAB_LIMIT, Math.max(MIN_TUI_TAB_LIMIT, Math.round(numericValue)));
}

export function normalizeSidebarWidth(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(numericValue)));
}

export function normalizeRemoteUiPort(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_REMOTE_UI_PORT;
  }
  return Math.min(MAX_REMOTE_UI_PORT, Math.max(MIN_REMOTE_UI_PORT, Math.round(numericValue)));
}

export type RemoteUiRuntimeState = "disabled" | "stopped" | "starting" | "running" | "error";

export interface RemoteUiStatus {
  readonly state: RemoteUiRuntimeState;
  readonly host?: string;
  readonly port?: number;
  readonly url?: string;
  readonly error?: string;
}

export interface NotificationPreferences {
  readonly backgroundCompletion: boolean;
  readonly backgroundFailure: boolean;
  readonly attentionNeeded: boolean;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly lastViewedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: SessionConfig;
}

export interface WorktreeRecord {
  readonly id: string;
  readonly rootWorkspaceId: string;
  readonly linkedWorkspaceId?: string;
  readonly name: string;
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly branchName?: string;
  readonly updatedAt: string;
}

export interface SessionExtensionStatusRecord {
  readonly key: string;
  readonly text: string;
}

export interface SessionExtensionWidgetRecord {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveComposer" | "belowComposer";
}

export type SessionExtensionDialogRecord = Extract<
  HostUiRequest,
  { readonly kind: "confirm" | "select" | "input" | "editor" }
>;

export interface SessionExtensionUiStateRecord {
  readonly statuses: readonly SessionExtensionStatusRecord[];
  readonly widgets: readonly SessionExtensionWidgetRecord[];
  readonly pendingDialogs: readonly SessionExtensionDialogRecord[];
  readonly title?: string;
  readonly editorText?: string;
}

export interface SystemPromptRecord {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ExtensionCommandCompatibilityStatus = "supported" | "terminal-only";

export interface ExtensionCommandCompatibilityRecord {
  readonly commandName: string;
  readonly extensionPath: string;
  readonly status: ExtensionCommandCompatibilityStatus;
  readonly message: string;
  readonly capability: string;
  readonly updatedAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly kind: WorkspaceKind;
  readonly rootWorkspaceId?: string;
  readonly branchName?: string;
  readonly sessions: readonly SessionRecord[];
}

export interface CreateWorktreeInput {
  readonly workspaceId: string;
  readonly fromSessionWorkspaceId?: string;
  readonly fromSessionId?: string;
}

export type StartThreadInput = {
  readonly rootWorkspaceId: string;
  readonly environment: NewThreadEnvironment;
  readonly prompt?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
};

export interface RemoveWorktreeInput {
  readonly workspaceId: string;
  readonly worktreeId: string;
}


export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly apiKey?: string;
  readonly oauthEnabled: boolean;
  readonly authorized: boolean;
  readonly enabled: boolean;
  readonly authorizedAt?: string;
  readonly lastAuthError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpServerConfigInput {
  readonly name: string;
  readonly url: string;
  readonly apiKey?: string;
  readonly oauthEnabled: boolean;
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly worktreesByWorkspace: Readonly<Record<string, readonly WorktreeRecord[]>>;
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarWidth: number;
  readonly runtimeByWorkspace: Readonly<Record<string, RuntimeSnapshot>>;
  readonly globalRuntime?: RuntimeSnapshot;
  readonly sessionCommandsBySession: Readonly<Record<string, readonly RuntimeCommandRecord[]>>;
  readonly sessionExtensionUiBySession: Readonly<Record<string, SessionExtensionUiStateRecord>>;
  readonly extensionCommandCompatibilityByWorkspace: Readonly<Record<string, readonly ExtensionCommandCompatibilityRecord[]>>;
  readonly notificationPreferences: NotificationPreferences;
  readonly integratedTerminalShell: string;
  readonly tuiTabLimit: number;
  readonly remoteUiPort: number;
  readonly remoteUiToken: string;
  readonly remoteUiStatus: RemoteUiStatus;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly workspaceOrder: readonly string[];
  readonly globalModelSettings: ModelSettingsSnapshot;
  readonly mcpServers: readonly McpServerConfig[];
  readonly systemPrompts: readonly SystemPromptRecord[];
  readonly activeSystemPromptId: string | undefined;
  readonly sidebarCollapsed: boolean;
  readonly enableTransparency: boolean;
  /** Background color for adaptive TUI terminal surfaces (hex). */
  readonly tuiBgColor: string;
  /** Background color for the right-hand split panel (hex). */
  readonly splitPanelBgColor: string;
  /** User's UI language preference: "auto" detects from system, "en"/"zh" are explicit. */
  readonly locale: LocaleSetting;
  readonly cliDetectionState: CliDetectionState;
  /** Per-CLI enable/disable map; missing keys are treated as enabled. */
  readonly cliEnablement: Readonly<Record<string, boolean>>;
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    worktreesByWorkspace: {},
    selectedWorkspaceId: "",
    selectedSessionId: "",
    activeView: "threads",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    runtimeByWorkspace: {},
    sessionCommandsBySession: {},
    sessionExtensionUiBySession: {},
    extensionCommandCompatibilityByWorkspace: {},
    notificationPreferences: {
      backgroundCompletion: true,
      backgroundFailure: true,
      attentionNeeded: true,
    },
    integratedTerminalShell: "",
    tuiTabLimit: DEFAULT_TUI_TAB_LIMIT,
    remoteUiPort: DEFAULT_REMOTE_UI_PORT,
    remoteUiToken: "",
    remoteUiStatus: {
      state: "stopped",
    },
    lastViewedAtBySession: {},
    workspaceOrder: [],
    globalModelSettings: {
      enabledModelPatterns: [],
    },
    mcpServers: [],
    systemPrompts: [],
    activeSystemPromptId: undefined,
    sidebarCollapsed: false,
    enableTransparency: false,
    tuiBgColor: DEFAULT_SURFACE_BG_COLOR,
    splitPanelBgColor: DEFAULT_SURFACE_BG_COLOR,
    locale: "auto",
    cliDetectionState: {
      detectedCLIs: {},
      lastDetectedAt: null,
      isDetecting: false,
      error: null,
    },
    cliEnablement: createDefaultCliEnablement(),
    revision: 0,
  };
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

// ── CLI 检测状态 ──

export interface CliDetectionState {
  readonly detectedCLIs: Readonly<Record<string, CliDetectionResult>>;
  readonly lastDetectedAt: number | null;
  readonly isDetecting: boolean;
  readonly error: string | null;
}

export interface CliDetectionResult {
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly installSource: string | null;
  readonly error: string | null;
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find((session) => session.id === state.selectedSessionId);
}
