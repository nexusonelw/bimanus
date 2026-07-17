import { useCallback, useMemo, useRef, useState } from "react";
import { DEFAULT_TUI_TAB_LIMIT, normalizeTuiTabLimit, type WorkspaceRecord, type WorkspaceSessionTarget } from "../desktop-state";
import { safeRandomUuid } from "../utils/uuid";

export function formatTuiTabLimitError(limit: number): string {
  return `TUI mode can keep up to ${normalizeTuiTabLimit(limit)} tabs open. Close a tab before opening another.`;
}

const TUI_NEW_SESSION_KEY_PREFIX = "pi-tui-new:";
const TUI_EXISTING_SESSION_KEY_PREFIX = "pi-tui-existing:";

export function piTuiTerminalScopeId(workspaceId: string): string {
  return `pi-tui-tabs:${workspaceId}`;
}

export type TuiTab =
  | {
      readonly kind: "existing";
      readonly key: string;
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly lastAccessedAt: number;
    }
  | {
      readonly kind: "new";
      readonly key: string;
      readonly workspaceId: string;
      readonly newSessionId: string;
      readonly lastAccessedAt: number;
    };

function createNewTuiSessionKey(workspaceId: string): string {
  return `${TUI_NEW_SESSION_KEY_PREFIX}${encodeURIComponent(workspaceId)}:${safeRandomUuid()}`;
}

export function isNewTuiSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(TUI_NEW_SESSION_KEY_PREFIX);
}

export function parseNewTuiWorkspaceId(sessionKey: string): string | undefined {
  if (!isNewTuiSessionKey(sessionKey)) {
    return undefined;
  }
  const remainder = sessionKey.slice(TUI_NEW_SESSION_KEY_PREFIX.length);
  const separatorIndex = remainder.lastIndexOf(":");
  const encodedWorkspaceId = separatorIndex >= 0 ? remainder.slice(0, separatorIndex) : remainder;
  try {
    return decodeURIComponent(encodedWorkspaceId);
  } catch {
    return undefined;
  }
}

export function parseExistingTuiSessionKey(sessionKey: string): WorkspaceSessionTarget | undefined {
  if (!sessionKey || isNewTuiSessionKey(sessionKey)) {
    return undefined;
  }

  if (sessionKey.startsWith(TUI_EXISTING_SESSION_KEY_PREFIX)) {
    const remainder = sessionKey.slice(TUI_EXISTING_SESSION_KEY_PREFIX.length);
    const separatorIndex = remainder.lastIndexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= remainder.length - 1) {
      return undefined;
    }

    try {
      const workspaceId = decodeURIComponent(remainder.slice(0, separatorIndex));
      const sessionId = decodeURIComponent(remainder.slice(separatorIndex + 1));
      return workspaceId && sessionId ? { workspaceId, sessionId } : undefined;
    } catch {
      return undefined;
    }
  }

  const separatorIndex = sessionKey.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= sessionKey.length - 1) {
    return undefined;
  }

  return {
    workspaceId: sessionKey.slice(0, separatorIndex),
    sessionId: sessionKey.slice(separatorIndex + 1),
  };
}

export function createExistingTuiSessionKey(target: WorkspaceSessionTarget): string {
  return [
    TUI_EXISTING_SESSION_KEY_PREFIX,
    encodeURIComponent(target.workspaceId),
    ":",
    encodeURIComponent(target.sessionId),
  ].join("");
}

export function hasTuiTabForTarget(tabs: readonly TuiTab[], target: WorkspaceSessionTarget): boolean {
  const key = createExistingTuiSessionKey(target);
  return tabs.some((tab) => tab.key === key);
}

export function sameWorkspaceSessionTarget(
  left: WorkspaceSessionTarget | undefined,
  right: WorkspaceSessionTarget | undefined,
): boolean {
  return Boolean(left && right && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId);
}

export function findWorkspaceById(workspaces: readonly WorkspaceRecord[], workspaceId: string | undefined): WorkspaceRecord | undefined {
  if (!workspaceId) {
    return undefined;
  }
  return workspaces.find((workspace) => workspace.id === workspaceId);
}

export function getTuiTabTarget(tab: TuiTab | undefined): WorkspaceSessionTarget | undefined {
  return tab?.kind === "existing" ? { workspaceId: tab.workspaceId, sessionId: tab.sessionId } : undefined;
}

function createNewTab(workspaceId: string): TuiTab {
  return {
    kind: "new",
    key: createNewTuiSessionKey(workspaceId),
    workspaceId,
    newSessionId: `pi-gui-${safeRandomUuid().replace(/-/g, "").slice(0, 24)}`,
    lastAccessedAt: Date.now(),
  };
}

function createExistingTab(target: WorkspaceSessionTarget, lastAccessedAt: number = Date.now()): TuiTab {
  return {
    kind: "existing",
    key: createExistingTuiSessionKey(target),
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    lastAccessedAt,
  };
}

function resolveActiveAfterClose(tabs: readonly TuiTab[], closedIndex: number, requestedKey?: string): string {
  if (requestedKey && tabs.some((tab) => tab.key === requestedKey)) {
    return requestedKey;
  }
  const nextIndex = Math.min(Math.max(closedIndex, 0), tabs.length - 1);
  return tabs[nextIndex]?.key ?? "";
}

function evictOldestTabs(
  tabs: readonly TuiTab[],
  maxTabs: number,
): { readonly tabs: readonly TuiTab[]; readonly evictedKeys: readonly string[]; readonly success: boolean } {
  let nextTabs = [...tabs];
  const evictedKeys: string[] = [];
  const max = normalizeTuiTabLimit(maxTabs);
  while (nextTabs.length >= max) {
    const [oldestTab] = nextTabs.splice(0, 1);
    if (!oldestTab) {
      return { tabs: nextTabs, evictedKeys, success: false };
    }
    evictedKeys.push(oldestTab.key);
  }
  return { tabs: nextTabs, evictedKeys, success: true };
}

export function useTuiTabs(maxTabs = DEFAULT_TUI_TAB_LIMIT) {
  const [tabs, setTabs] = useState<readonly TuiTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [visible, setVisible] = useState(false);
  const tabsRef = useRef(tabs);
  const activeKeyRef = useRef(activeKey);
  const visibleRef = useRef(visible);

  tabsRef.current = tabs;
  activeKeyRef.current = activeKey;
  visibleRef.current = visible;

  const commit = useCallback((nextTabs: readonly TuiTab[], nextActiveKey: string, nextVisible: boolean) => {
    const now = Date.now();
    const updatedTabs = nextTabs.map(tab => 
      tab.key === nextActiveKey ? { ...tab, lastAccessedAt: now } : tab
    );
    tabsRef.current = updatedTabs;
    activeKeyRef.current = nextActiveKey;
    visibleRef.current = nextVisible;
    setTabs(updatedTabs);
    setActiveKey(nextActiveKey);
    setVisible(nextVisible);
  }, []);

  const openExisting = useCallback((target: WorkspaceSessionTarget): { success: boolean; evictedKeys: string[] } => {
    const nextKey = createExistingTuiSessionKey(target);
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((tab) => tab.key === nextKey);
    if (existing) {
      commit(currentTabs, existing.key, true);
      return { success: true, evictedKeys: [] };
    }

    const evicted = evictOldestTabs(currentTabs, maxTabs);
    if (!evicted.success) {
      return { success: false, evictedKeys: [...evicted.evictedKeys] };
    }
    const nextTabs = [...evicted.tabs];
    nextTabs.push(createExistingTab(target));
    commit(nextTabs, nextKey, true);
    return { success: true, evictedKeys: [...evicted.evictedKeys] };
  }, [commit, maxTabs]);

  const openNew = useCallback((workspaceId: string): { success: boolean; evictedKeys: string[] } => {
    const currentTabs = tabsRef.current;
    const evicted = evictOldestTabs(currentTabs, maxTabs);
    if (!evicted.success) {
      return { success: false, evictedKeys: [...evicted.evictedKeys] };
    }
    const nextTabs = [...evicted.tabs];
    const nextTab = createNewTab(workspaceId);
    nextTabs.push(nextTab);
    commit(nextTabs, nextTab.key, true);
    return { success: true, evictedKeys: [...evicted.evictedKeys] };
  }, [commit, maxTabs]);

  const activateExisting = useCallback((target: WorkspaceSessionTarget): boolean => {
    const key = createExistingTuiSessionKey(target);
    const currentTabs = tabsRef.current;
    if (!currentTabs.some((tab) => tab.key === key)) {
      return false;
    }
    commit(currentTabs, key, true);
    return true;
  }, [commit]);

  const activateKey = useCallback((key: string): boolean => {
    const currentTabs = tabsRef.current;
    if (!currentTabs.some((tab) => tab.key === key)) {
      return false;
    }
    commit(currentTabs, key, true);
    return true;
  }, [commit]);

  const hide = useCallback(() => {
    const currentTabs = tabsRef.current;
    const currentActiveKey = activeKeyRef.current;
    const activeTab = currentTabs.find((tab) => tab.key === currentActiveKey);
    if (activeTab?.kind !== "new") {
      commit(currentTabs, currentActiveKey, false);
      return activeTab?.key;
    }
    const closedIndex = currentTabs.findIndex((tab) => tab.key === currentActiveKey);
    const nextTabs = currentTabs.filter((tab) => tab.key !== currentActiveKey);
    commit(nextTabs, resolveActiveAfterClose(nextTabs, closedIndex), false);
    return activeTab.key;
  }, [commit]);

  const close = useCallback((key: string, nextActiveKey?: string) => {
    const currentTabs = tabsRef.current;
    const closedIndex = currentTabs.findIndex((tab) => tab.key === key);
    if (closedIndex < 0) {
      return undefined;
    }
    const closedTab = currentTabs[closedIndex];
    const nextTabs = currentTabs.filter((tab) => tab.key !== key);
    const nextKey = key === activeKeyRef.current
      ? resolveActiveAfterClose(nextTabs, closedIndex, nextActiveKey)
      : activeKeyRef.current;
    commit(nextTabs, nextKey, visibleRef.current && nextTabs.length > 0);
    return closedTab;
  }, [commit]);

  const prune = useCallback((isValid: (tab: TuiTab) => boolean) => {
    const currentTabs = tabsRef.current;
    const nextTabs = currentTabs.filter(isValid);
    if (nextTabs.length === currentTabs.length) {
      return;
    }
    const nextActiveKey = nextTabs.some((tab) => tab.key === activeKeyRef.current)
      ? activeKeyRef.current
      : nextTabs[0]?.key ?? "";
    commit(nextTabs, nextActiveKey, visibleRef.current && nextTabs.length > 0);
  }, [commit]);

  const materializeNewTabs = useCallback((workspaces: readonly WorkspaceRecord[]) => {
    const currentTabs = tabsRef.current;
    let changed = false;
    const existingKeys = new Set(currentTabs.filter((tab) => tab.kind === "existing").map((tab) => tab.key));
    const nextTabs: TuiTab[] = [];
    let nextActiveKey = activeKeyRef.current;

    for (const tab of currentTabs) {
      if (tab.kind !== "new") {
        nextTabs.push(tab);
        continue;
      }
      const workspace = workspaces.find((entry) => entry.id === tab.workspaceId);
      const materializedSession = workspace?.sessions.find((session) => session.id === tab.newSessionId);
      if (!materializedSession) {
        nextTabs.push(tab);
        continue;
      }

      changed = true;
      const existingTab = createExistingTab({
        workspaceId: tab.workspaceId,
        sessionId: materializedSession.id,
      }, tab.lastAccessedAt);
      if (existingKeys.has(existingTab.key)) {
        if (nextActiveKey === tab.key) {
          nextActiveKey = existingTab.key;
        }
        continue;
      }
      existingKeys.add(existingTab.key);
      if (nextActiveKey === tab.key) {
        nextActiveKey = existingTab.key;
      }
      nextTabs.push(existingTab);
    }

    if (!changed) {
      return;
    }
    commit(nextTabs, nextActiveKey, visibleRef.current && nextTabs.length > 0);
  }, [commit]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey),
    [activeKey, tabs],
  );

  return {
    tabs,
    activeTab,
    activeKey,
    activeKeyRef,
    visible,
    visibleRef,
    visibleTab: visible ? activeTab : undefined,
    openSessionKey: visible && activeTab ? activeTab.key : "",
    openExisting,
    openNew,
    activateKey,
    activateExisting,
    hide,
    close,
    prune,
    materializeNewTabs,
  };
}
