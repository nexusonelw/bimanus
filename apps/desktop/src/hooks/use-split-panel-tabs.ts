/**
 * ============================================================
 * useSplitPanelTabs — 分屏 Tab 管理 Hook
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §3 Tab 管理系统
 *
 * 职责:
 * - 管理 Tab 列表、激活态
 * - Tab 关闭时联动后端：SplitPanel.handleCloseTab 在移除 React 状态前先
 *   取出 tab.sessionId，经 App.tsx 的 onTabClosed 调用
 *   api.closeTerminalSession(sessionId) 终结后端 PTY 子进程组
 *   （OpenCode / Claude Code / CodeX 全部一并 kill）。
 * - LRU 淘汰策略
 * - 后台状态追踪
 *
 * 使用模式:
 *   const tabsManager = useSplitPanelTabs(sessionKey);
 *   tabsManager.createTab({ cliType: "codex" });
 *   tabsManager.activateTab(tabId);
 *   tabsManager.closeTab(tabId);
 */

import { useCallback, useRef, useState } from "react";
import type { CliType, CreateTabConfig, SplitPanelTab, SplitLayout } from "../split-panel/types";

// ── 工具函数 ──

let nextTabId = 1;

function generateTabId(): string {
  return `split-tab-${nextTabId++}`;
}

/**
 * 统计指定 CLI 类型的已有 Tab 数量
 */
function countTabsByType(tabs: SplitPanelTab[], cliType: CliType): number {
  return tabs.filter((t) => t.cliType === cliType).length;
}

/**
 * 自动生成 Tab 标题
 * 格式: "CodeX #1", "Claude #2", "OpenCode #3"
 */
function generateTabTitle(tabs: SplitPanelTab[], cliType: CliType): string {
  const typeName = cliType === "codex" ? "CodeX"
    : cliType === "claude" ? "Claude"
    : cliType === "opencode" ? "OpenCode"
    : cliType === "grok" ? "Grok"
    : cliType === "copilot" ? "Copilot"
    : cliType === "antigravity" ? "Antigravity"
    : cliType === "kiro" ? "Kiro"
    : cliType === "cursor" ? "Cursor"
    : "Droid";
  const count = countTabsByType(tabs, cliType) + 1;
  return `${typeName} #${count}`;
}

/**
 * LRU 排序: 最近使用的排在前面
 */
function sortByLastAccessed(tabs: SplitPanelTab[]): SplitPanelTab[] {
  return [...tabs].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
}

function getPaneCountForLayout(layout: SplitLayout): number {
  switch (layout) {
    case "single": return 1;
    case "dual":   return 2;
    case "quad":   return 2;
    case "grid4":  return 4;
  }
}

/**
 * 会话内部的 SplitPanel 状态缓存模型
 */
export interface SessionState {
  tabs: SplitPanelTab[];
  activeTabId: string | null;
  layout: SplitLayout;
  paneAssignment: (string | null)[];
}

const DEFAULT_SESSION_STATE: SessionState = {
  tabs: [],
  activeTabId: null,
  layout: "single",
  paneAssignment: [null],
};

// ── Hook ──

export interface UseSplitPanelTabsReturn {
  /** 所有 Tab 列表 */
  tabs: SplitPanelTab[];

  /** 当前激活的 Tab ID */
  activeTabId: string | null;

  /** 当前布局 */
  layout: SplitLayout;

  /** Pane 分配 */
  paneAssignment: (string | null)[];

  // ── Tab 操作 ──

  /** 新建 Tab */
  createTab: (config: CreateTabConfig) => string;

  /** 激活指定 Tab */
  activateTab: (tabId: string) => void;

  /** 关闭指定 Tab */
  closeTab: (tabId: string) => void;

  /** 关闭所有 Tab */
  closeAllTabs: () => void;

  /** 更新 Tab 标题 */
  updateTabTitle: (tabId: string, title: string) => void;

  /** 更新 Tab 状态 */
  updateTabStatus: (tabId: string, status: SplitPanelTab["status"]) => void;

  /** 更新 Tab 会话信息 */
  updateTabSession: (tabId: string, sessionId: string | null, pid: number | null) => void;

  // ── 布局操作 ──

  /** 切换布局模式 */
  setLayout: (layout: SplitLayout) => void;

  /** 分配 Tab 到指定 Pane */
  assignTabToPane: (paneIndex: number, tabId: string | null) => void;

  // ── 状态查询 ──

  /** 获取指定 Pane 的 Tab */
  getTabForPane: (paneIndex: number) => SplitPanelTab | null;

  /** 获取指定 Tab */
  getTab: (tabId: string) => SplitPanelTab | undefined;

  /** 获取活跃 Tab */
  getActiveTab: () => SplitPanelTab | null;

  /** 清理无效会话的数据 */
  prune: (validWorkspaceIds: Set<string>) => void;
}

export function useSplitPanelTabs(workspaceId: string): UseSplitPanelTabsReturn {
  const [cache, setCache] = useState<Record<string, SessionState>>({});

  const currentState = cache[workspaceId] ?? DEFAULT_SESSION_STATE;

  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const updateState = useCallback((updater: (state: SessionState) => SessionState) => {
    const currentKey = workspaceIdRef.current;
    if (!currentKey) return;

    setCache((prev) => {
      const oldState = prev[currentKey] ?? DEFAULT_SESSION_STATE;
      const newState = updater(oldState);
      if (oldState === newState) return prev;
      return { ...prev, [currentKey]: newState };
    });
  }, []);

  // ── Tab 操作 ──

  const createTab = useCallback((config: CreateTabConfig): string => {
    const id = config.id ?? generateTabId();
    updateState((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return state;
      }
      const newTab: SplitPanelTab = {
        id,
        title: generateTabTitle(state.tabs, config.cliType),
        cliType: config.cliType,
        cwd: config.cwd ?? "",
        sessionId: null,
        prompt: config.prompt,
        pid: null,
        status: "pending",
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      };

      const newTabs = [...state.tabs, newTab];
      const paneCount = getPaneCountForLayout(state.layout);
      const nextPaneAssignment = [...state.paneAssignment];

      // 确保长度匹配
      while (nextPaneAssignment.length < paneCount) {
        nextPaneAssignment.push(null);
      }

      // 找第一个空 Pane 分配
      const emptyIndex = nextPaneAssignment.indexOf(null);
      if (emptyIndex !== -1) {
        nextPaneAssignment[emptyIndex] = id;
      } else if (nextPaneAssignment.length > 0) {
        // 全满时替换最后一个
        nextPaneAssignment[nextPaneAssignment.length - 1] = id;
      }

      return {
        ...state,
        tabs: newTabs,
        activeTabId: id,
        paneAssignment: nextPaneAssignment,
      };
    });
    return id;
  }, [updateState]);

  const activateTab = useCallback((tabId: string) => {
    updateState((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === tabId ? { ...t, lastAccessedAt: Date.now() } : t
      );

      let nextPaneAssignment = state.paneAssignment;
      if (!nextPaneAssignment.includes(tabId)) {
        nextPaneAssignment = nextPaneAssignment.length > 0 ? [...nextPaneAssignment] : [null];
        const activePaneIndex = state.activeTabId ? nextPaneAssignment.indexOf(state.activeTabId) : -1;
        nextPaneAssignment[activePaneIndex >= 0 ? activePaneIndex : 0] = tabId;
      }

      return {
        ...state,
        tabs: newTabs,
        activeTabId: tabId,
        paneAssignment: nextPaneAssignment,
      };
    });
  }, [updateState]);

  const closeTab = useCallback((tabId: string) => {
    updateState((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      const newPaneAssignment = state.paneAssignment.map((assigned) => (assigned === tabId ? null : assigned));

      let newActiveTabId = state.activeTabId;
      if (newActiveTabId === tabId) {
        const remaining = state.tabs.filter((t) => t.id !== tabId);
        const nextActive = sortByLastAccessed(remaining)[0];
        newActiveTabId = nextActive ? nextActive.id : null;
      }

      return {
        ...state,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        paneAssignment: newPaneAssignment,
      };
    });
  }, [updateState]);

  const closeAllTabs = useCallback(() => {
    updateState((state) => ({
      ...state,
      tabs: [],
      paneAssignment: [],
      activeTabId: null,
    }));
  }, [updateState]);

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    updateState((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    }));
  }, [updateState]);

  const updateTabStatus = useCallback((tabId: string, status: SplitPanelTab["status"]) => {
    updateState((state) => ({
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
    }));
  }, [updateState]);

  const updateTabSession = useCallback(
    (tabId: string, sessionId: string | null, pid: number | null) => {
      updateState((state) => ({
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, sessionId, pid, status: "active" as const } : t
        ),
      }));
    },
    [updateState],
  );

  // ── 布局操作 ──

  const setLayout = useCallback((newLayout: SplitLayout) => {
    updateState((state) => {
      const paneCount = getPaneCountForLayout(newLayout);
      const next: (string | null)[] = [...state.paneAssignment];
      while (next.length < paneCount) {
        next.push(null);
      }
      const isEmptyAssignment = next.every((id): boolean => id === null);
      if (isEmptyAssignment && state.activeTabId) {
        next[0] = state.activeTabId;
      }
      return {
        ...state,
        layout: newLayout,
        paneAssignment: next.slice(0, paneCount),
      };
    });
  }, [updateState]);

  const assignTabToPane = useCallback((paneIndex: number, tabId: string | null) => {
    updateState((state) => {
      const next = [...state.paneAssignment];
      next[paneIndex] = tabId;
      return {
        ...state,
        paneAssignment: next,
        activeTabId: tabId ? tabId : state.activeTabId,
      };
    });
  }, [updateState]);

  // ── 状态查询 ──

  const getTabForPane = useCallback(
    (paneIndex: number): SplitPanelTab | null => {
      const tabId = currentState.paneAssignment[paneIndex];
      if (!tabId) return null;
      return currentState.tabs.find((t) => t.id === tabId) ?? null;
    },
    [currentState.paneAssignment, currentState.tabs],
  );

  const getTab = useCallback(
    (tabId: string): SplitPanelTab | undefined => {
      return currentState.tabs.find((t) => t.id === tabId);
    },
    [currentState.tabs],
  );

  const getActiveTab = useCallback((): SplitPanelTab | null => {
    if (!currentState.activeTabId) return null;
    return currentState.tabs.find((t) => t.id === currentState.activeTabId) ?? null;
  }, [currentState.activeTabId, currentState.tabs]);

  const prune = useCallback((validWorkspaceIds: Set<string>) => {
    setCache((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!validWorkspaceIds.has(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  return {
    tabs: currentState.tabs,
    activeTabId: currentState.activeTabId,
    layout: currentState.layout,
    paneAssignment: currentState.paneAssignment,
    createTab,
    activateTab,
    closeTab,
    closeAllTabs,
    updateTabTitle,
    updateTabStatus,
    updateTabSession,
    setLayout,
    assignTabToPane,
    getTabForPane,
    getTab,
    getActiveTab,
    prune,
  };
}
