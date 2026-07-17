import type {
  AppView,
  ExtensionCommandCompatibilityRecord,
  McpServerConfig,
  NotificationPreferences,
  SystemPromptRecord,
} from "../src/desktop-state";
import {
  DEFAULT_SURFACE_BG_COLOR,
  normalizeLocale,
  normalizeRemoteUiPort,
  normalizeSurfaceBgColor,
  normalizeTuiTabLimit,
} from "../src/desktop-state";

import type { ModelSettingsSnapshot } from "@bimanus/session-driver/runtime-types";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const uiStateWriteQueueByPath = new Map<string, Promise<void>>();
export interface McpServerOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly tokenType?: string;
  readonly scope?: string;
}

export interface PersistedMcpServerConfig extends McpServerConfig {
  readonly oauthTokens?: McpServerOAuthTokens;
}

export interface PersistedUiState {
  readonly version?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
  readonly systemPrompts?: readonly SystemPromptRecord[];
  readonly activeSystemPromptId?: string;
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly extensionCommandCompatibilityByWorkspace?: Record<string, readonly ExtensionCommandCompatibilityRecord[]>;
  readonly notificationPreferences?: NotificationPreferences;
  readonly integratedTerminalShell?: string;
  readonly tuiTabLimit?: number;
  readonly remoteUiPort?: number;
  readonly remoteUiToken?: string;
  readonly lastViewedAtBySession?: Record<string, string>;
  readonly workspaceOrder?: readonly string[];
  readonly appGlobalModelSettings?: ModelSettingsSnapshot;
  readonly mcpServers?: readonly PersistedMcpServerConfig[];
  readonly sidebarCollapsed?: boolean;
  readonly sidebarWidth?: number;
  readonly allowMultiple?: boolean;
  readonly enableTransparency?: boolean;
  /** Background color for adaptive TUI terminal surfaces (hex). */
  readonly tuiBgColor?: string;
  /** Background color for the right-hand split panel (hex). */
  readonly splitPanelBgColor?: string;
  /** UI language preference: "auto" detects from system, "en"/"zh" are explicit. */
  readonly locale?: "auto" | "en" | "zh";
  /** Per-CLI enable/disable map (missing keys default to enabled). */
  readonly cliEnablement?: Readonly<Record<string, boolean>>;
}

export interface LegacyPersistedUiState extends PersistedUiState {
}

export async function readPersistedUiState(uiStateFilePath: string): Promise<LegacyPersistedUiState> {
  try {
    const raw = await readFile(uiStateFilePath, "utf8");
    const parsed = JSON.parse(raw) as LegacyPersistedUiState;
    return {
      version:
        parsed.version === 16
          ? 16
          : parsed.version === 15
          ? 15
          : parsed.version === 14
          ? 14
          : parsed.version === 13
          ? 13
          : parsed.version === 12
            ? 12
            : parsed.version === 11
              ? 11
              : parsed.version === 10
                ? 10
                : parsed.version === 9
                  ? 9
                  : parsed.version === 8
                    ? 8
                    : parsed.version === 7
                      ? 7
                      : parsed.version === 6
                        ? 6
                        : parsed.version === 5
                          ? 5
                          : parsed.version === 4
                            ? 4
                            : parsed.version === 3
                              ? 3
                              : parsed.version === 2
                                ? 2
                                : undefined,
      selectedWorkspaceId: parsed.selectedWorkspaceId,
      selectedSessionId: parsed.selectedSessionId,
      activeView: parsed.activeView,
      extensionCommandCompatibilityByWorkspace: parsed.extensionCommandCompatibilityByWorkspace,
      notificationPreferences: parsed.notificationPreferences,
      integratedTerminalShell:
        typeof parsed.integratedTerminalShell === "string" ? parsed.integratedTerminalShell : undefined,
      tuiTabLimit: parsed.tuiTabLimit === undefined ? undefined : normalizeTuiTabLimit(parsed.tuiTabLimit),
      remoteUiPort: parsed.remoteUiPort === undefined ? undefined : normalizeRemoteUiPort(parsed.remoteUiPort),
      remoteUiToken: typeof parsed.remoteUiToken === "string" ? parsed.remoteUiToken : undefined,
      lastViewedAtBySession: parsed.lastViewedAtBySession,
      workspaceOrder: Array.isArray(parsed.workspaceOrder) ? parsed.workspaceOrder : undefined,
      appGlobalModelSettings: toPersistedModelSettingsSnapshot(parsed.appGlobalModelSettings),
      mcpServers: toPersistedMcpServers(parsed.mcpServers),
      systemPrompts: Array.isArray(parsed.systemPrompts) ? parsed.systemPrompts : undefined,
      activeSystemPromptId: typeof parsed.activeSystemPromptId === "string" ? parsed.activeSystemPromptId : undefined,
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined,
      sidebarWidth: typeof parsed.sidebarWidth === "number" && Number.isFinite(parsed.sidebarWidth)
        ? parsed.sidebarWidth
        : undefined,
      allowMultiple: typeof parsed.allowMultiple === "boolean" ? parsed.allowMultiple : undefined,
      enableTransparency: typeof parsed.enableTransparency === "boolean" ? parsed.enableTransparency : undefined,
      tuiBgColor:
        typeof parsed.tuiBgColor === "string"
          ? normalizeSurfaceBgColor(parsed.tuiBgColor, DEFAULT_SURFACE_BG_COLOR)
          : undefined,
      splitPanelBgColor:
        typeof parsed.splitPanelBgColor === "string"
          ? normalizeSurfaceBgColor(parsed.splitPanelBgColor, DEFAULT_SURFACE_BG_COLOR)
          : undefined,
      locale: typeof parsed.locale === "string" ? normalizeLocale(parsed.locale) : undefined,
      cliEnablement: toPersistedCliEnablement(parsed.cliEnablement),
    };
  } catch {
    return {};
  }
}

function toPersistedCliEnablement(value: unknown): Readonly<Record<string, boolean>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && key.trim().length > 0 && typeof entry === "boolean") {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function writePersistedUiState(
  uiStateFilePath: string,
  payload: PersistedUiState,
): Promise<void> {
  await enqueueUiStateWrite(uiStateFilePath, async () => {
    await mkdir(dirname(uiStateFilePath), { recursive: true });
    const serialized = `${JSON.stringify(
      {
        version: 16,
        ...payload,
      } satisfies PersistedUiState,
      null,
      2,
    )}\n`;
    const tmpPath = `${uiStateFilePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, serialized, "utf8");

    try {
      await rename(tmpPath, uiStateFilePath);
    } catch (error) {
      if (!isReplaceRenameError(error)) {
        await cleanupTempFile(tmpPath);
        throw error;
      }

      try {
        await unlink(uiStateFilePath);
      } catch (unlinkError) {
        if (!isMissingFileError(unlinkError)) {
          await cleanupTempFile(tmpPath);
          throw unlinkError;
        }
      }

      try {
        await rename(tmpPath, uiStateFilePath);
      } catch (renameError) {
        await cleanupTempFile(tmpPath);
        throw renameError;
      }
    }
  });
}

function toPersistedModelSettingsSnapshot(value: unknown): ModelSettingsSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const enabledModelPatterns = Array.isArray(candidate.enabledModelPatterns)
    ? candidate.enabledModelPatterns.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...(typeof candidate.defaultProvider === "string" ? { defaultProvider: candidate.defaultProvider } : {}),
    ...(typeof candidate.defaultModelId === "string" ? { defaultModelId: candidate.defaultModelId } : {}),
    ...(typeof candidate.defaultThinkingLevel === "string"
      ? { defaultThinkingLevel: candidate.defaultThinkingLevel as ModelSettingsSnapshot["defaultThinkingLevel"] }
      : {}),
    enabledModelPatterns,
  };
}

function toPersistedMcpServers(value: unknown): readonly PersistedMcpServerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): PersistedMcpServerConfig[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
    if (!id || !name || !isHttpUrl(url)) {
      return [];
    }

    const oauthEnabled = typeof candidate.oauthEnabled === "boolean" ? candidate.oauthEnabled : false;
    const enabled = typeof candidate.enabled === "boolean" ? candidate.enabled : true;
    const oauthTokens = toMcpServerOAuthTokens(candidate.oauthTokens);
    const authorized = oauthEnabled ? Boolean(candidate.authorized) && Boolean(oauthTokens) : true;
    const now = new Date(0).toISOString();
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : now;
    const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt;

    return [{
      id,
      name,
      url,
      ...(apiKey ? { apiKey } : {}),
      oauthEnabled,
      authorized,
      enabled,
      ...(authorized && typeof candidate.authorizedAt === "string" ? { authorizedAt: candidate.authorizedAt } : {}),
      ...(typeof candidate.lastAuthError === "string" ? { lastAuthError: candidate.lastAuthError } : {}),
      createdAt,
      updatedAt,
      ...(oauthTokens ? { oauthTokens } : {}),
    }];
  });
}

function toMcpServerOAuthTokens(value: unknown): McpServerOAuthTokens | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessToken !== "string" || candidate.accessToken.length === 0) {
    return undefined;
  }
  return {
    accessToken: candidate.accessToken,
    ...(typeof candidate.refreshToken === "string" ? { refreshToken: candidate.refreshToken } : {}),
    ...(typeof candidate.expiresAt === "string" ? { expiresAt: candidate.expiresAt } : {}),
    ...(typeof candidate.tokenType === "string" ? { tokenType: candidate.tokenType } : {}),
    ...(typeof candidate.scope === "string" ? { scope: candidate.scope } : {}),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isReplaceRenameError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EEXIST" || error.code === "EPERM");
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function enqueueUiStateWrite(uiStateFilePath: string, write: () => Promise<void>): Promise<void> {
  const previous = uiStateWriteQueueByPath.get(uiStateFilePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  uiStateWriteQueueByPath.set(uiStateFilePath, next);

  try {
    await next;
  } finally {
    if (uiStateWriteQueueByPath.get(uiStateFilePath) === next) {
      uiStateWriteQueueByPath.delete(uiStateFilePath);
    }
  }
}
