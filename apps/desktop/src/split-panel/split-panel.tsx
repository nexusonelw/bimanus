/**
 * ============================================================
 * SplitPanel — 右侧分屏面板主容器组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §2 整体布局架构
 *
 * SplitPanel 是整个右侧分屏的入口组件。
 * 使用 Presenter 模式 — 只做布局容器，不管理 CLI 进程生命周期。
 *
 * 组件结构:
 * ┌─────────────────────────────────────────────┐
 * │  SplitPanelToolbar (Tab 条 + 布局切换器)    │
 * ├─────────────────────────────────────────────┤
 * │  SplitPanelCanvas (Grid 布局容器)           │
 * │  ┌──────────┬──────────┐                    │
 * │  │ Pane[0]  │ Pane[1]  │                    │
 * │  ├──────────┼──────────┤                    │
 * │  │ Pane[2]  │ Pane[3]  │                    │
 * │  └──────────┴──────────┘                    │
 * ├─────────────────────────────────────────────┤
 * │  WorkspaceBindingIndicator                   │
 * └─────────────────────────────────────────────┘
 */

import React, { useCallback, useRef, type CSSProperties } from "react";
import type { CliEnablementMap } from "../cli-enablement";
import type { WorkspaceRecord } from "../desktop-state";
import type { TerminalSessionSnapshot } from "../ipc";
import type { CliType, SplitLayout, SplitPanelTab } from "./types";
import { SplitPanelToolbar } from "./split-panel-toolbar";
import { SplitPanelCanvas } from "./split-panel-canvas";
import { SplitPanelDivider } from "./split-panel-divider";
import { WorkspaceBindingIndicator } from "./workspace-binding-indicator";
import { useSplitPanelResize } from "../hooks/use-split-panel-resize";
import type { UseSplitPanelTabsReturn } from "../hooks/use-split-panel-tabs";
import "./split-panel.css";

/**
 * 把后端 TerminalSessionStatus（running/exited/error）映射为
 * SplitPanelTab 的 UI 状态。exited 时根据 exitCode 是否为 0 区分
 * "已完成" 与 "已终止"，没有 exitCode 时默认按 killed 处理。
 */
function mapTerminalStatusToTabStatus(session: TerminalSessionSnapshot): SplitPanelTab["status"] {
  switch (session.status) {
    case "running":
      return "active";
    case "error":
      return "error";
    case "exited":
      return session.exitCode === 0 ? "completed" : "killed";
    default:
      return "idle";
  }
}

// ── Props ──

export interface SplitPanelProps {
  /** Tab 管理器 */
  readonly tabsManager: UseSplitPanelTabsReturn;

  /** 是否可见 */
  readonly visible?: boolean;

  /** 侧边栏宽度（用于计算默认分屏宽度） */
  readonly sidebarWidth?: number;

  /** 窗口宽度 */
  readonly windowWidth?: number;

  /** 当前工作区路径（follow-workspace 模式使用） */
  readonly workspacePath?: string;

  /** 当前工作区记录（用于派生 PTY，传给内部 TerminalPanel） */
  readonly workspace?: WorkspaceRecord | null;

  /** 是否显示工作目录指示器 */
  readonly showCwdIndicator?: boolean;

  /** CLI enablement map used to filter the new-session dropdown */
  readonly cliEnablement?: CliEnablementMap;

  /**
   * Optional light-theme surface background (hex). Injected as
   * `--surface-bg-custom` so the panel chrome and nested adaptive terminals
   * share the same custom surface color without overriding dark tokens.
   */
  readonly surfaceBgColor?: string;

  // ── 回调 ──

  /** 可见性变更回调 */
  readonly onVisibilityChange?: (visible: boolean) => void;

  /** Tab 创建回调（可在此处触发 CLI 启动） */
  readonly onTabCreated?: (tab: SplitPanelTab) => void;

  /** Tab 关闭回调 — 携带后端 PTY 真实 sessionId（可能为 null：Tab 在
   *  CLI 会话建立前就被关闭，此时无后端进程需要终结）。 */
  readonly onTabClosed?: (tabId: string, sessionId: string | null) => void;

  /** 错误回调 */
  readonly onError?: (error: Error) => void;
}

// ── 组件 ──

/**
 * 右侧分屏面板主容器
 *
 * 使用 useSplitPanelResize 管理宽度拖拽
 * 使用 useCallback 优化子组件渲染
 */
export function SplitPanel({
  tabsManager,
  visible: externalVisible,
  sidebarWidth = 292,
  windowWidth,
  workspacePath = "",
  workspace = null,
  showCwdIndicator = true,
  cliEnablement,
  surfaceBgColor,
  onVisibilityChange,
  onTabCreated,
  onTabClosed,
  onError,
}: SplitPanelProps) {
  // ── 状态管理 ──
  const resizeManager = useSplitPanelResize({
    sidebarWidth,
    windowWidth,
    onResizeCommit: (width) => {},
  });

  // 可见性受外部控制
  const isVisible = externalVisible ?? true;

  // ── 终端重启函数注册表 ──
  // 每个 Pane 内嵌的 TerminalPanel 在挂载时注册自己的 restartTerminal 函数，
  // SplitPanelToolbar 的 "重启" 按钮通过 activeTabId 查找到对应函数后调用。
  const restartHandlersRef = useRef(new Map<string, () => void>());

  const handleRegisterRestart = useCallback(
    (tabId: string, fn: (() => void) | null) => {
      if (fn) {
        restartHandlersRef.current.set(tabId, fn);
      } else {
        restartHandlersRef.current.delete(tabId);
      }
    },
    [],
  );

  const handleRestartActive = useCallback(() => {
    const activeId = tabsManager.activeTabId;
    if (!activeId) {
      return;
    }
    const fn = restartHandlersRef.current.get(activeId);
    if (fn) {
      fn();
    }
  }, [tabsManager.activeTabId]);

  // ── 事件处理 ──

  /** 新建 CLI 会话 */
  const handleCreateSession = useCallback(
    (cliType: CliType) => {
      try {
        const tabId = tabsManager.createTab({ cliType });
        const newTab = tabsManager.getTab(tabId);
        if (newTab) {
          onTabCreated?.(newTab);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [tabsManager, onTabCreated, onError],
  );

  /** 激活 Tab */
  const handleActivateTab = useCallback(
    (tabId: string) => {
      tabsManager.activateTab(tabId);
    },
    [tabsManager],
  );

  /** 关闭 Tab — 必须在 React 状态移除前先取出 sessionId，否则下游
   *  onTabClosed 拿不到后端 PTY 句柄，无法终结子进程组。 */
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabsManager.getTab(tabId);
      const sessionId = tab?.sessionId ?? null;
      tabsManager.closeTab(tabId);
      onTabClosed?.(tabId, sessionId);
    },
    [tabsManager, onTabClosed],
  );

  /** 关闭所有 Tab — 先快照所有 {id, sessionId}，再清空状态，最后逐个上抛。 */
  const handleCloseAllTabs = useCallback(() => {
    const closingTabs = tabsManager.tabs.map((t) => ({ id: t.id, sessionId: t.sessionId }));
    tabsManager.closeAllTabs();
    for (const { id, sessionId } of closingTabs) {
      onTabClosed?.(id, sessionId);
    }
  }, [tabsManager, onTabClosed]);

  /** 关闭面板 */
  const handleClosePanel = useCallback(() => {
    onVisibilityChange?.(false);
  }, [onVisibilityChange]);

  /** Pane 点击激活 */
  const handlePaneActivate = useCallback(
    (paneIndex: number) => {
      const tabId = tabsManager.paneAssignment[paneIndex];
      if (tabId) {
        tabsManager.activateTab(tabId);
      }
    },
    [tabsManager],
  );

  /** 切换布局 */
  const handleChangeLayout = useCallback(
    (layout: SplitLayout) => {
      tabsManager.setLayout(layout);
    },
    [tabsManager],
  );

  /**
   * 终端会话激活/更新回调 — 由内部 <TerminalPanel> 在会话创建、切换或
   * 状态变化时上抛，回写 Tab 的 sessionId / pid / status，保证
   * SplitPanelTab（前端展示态）与 TerminalSessionSnapshot（后端 PTY 真实态）
   * 这两套状态维度对齐，不再互相失联。
   */
  const handleSessionActiveChange = useCallback(
    (tabId: string, session: TerminalSessionSnapshot) => {
      tabsManager.updateTabSession(tabId, session.id, null);
      tabsManager.updateTabStatus(tabId, mapTerminalStatusToTabStatus(session));
    },
    [tabsManager],
  );

  /** 终端会话关闭回调 — 把 Tab 标记为 completed / killed，并清理其激活的会话引用 */
  const handleSessionClosed = useCallback(
    (
      tabId: string,
      closedSession: TerminalSessionSnapshot,
      nextActiveSession: TerminalSessionSnapshot | undefined,
    ) => {
      if (nextActiveSession) {
        tabsManager.updateTabSession(tabId, nextActiveSession.id, null);
        tabsManager.updateTabStatus(tabId, mapTerminalStatusToTabStatus(nextActiveSession));
      } else {
        tabsManager.updateTabSession(tabId, null, null);
        tabsManager.updateTabStatus(tabId, mapTerminalStatusToTabStatus(closedSession));
      }
    },
    [tabsManager],
  );

  // 是否可以切换布局
  const canChangeLayout = tabsManager.tabs.length >= 1;

  // ── 渲染 ──

  if (!isVisible) return null;

  const containerClassName = [
    "split-panel",
    resizeManager.isDragging ? "split-panel--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const containerStyle = surfaceBgColor
    ? ({ "--surface-bg-custom": surfaceBgColor } as CSSProperties)
    : undefined;

  return (
    <>
      {/* 分割条 — 放在 SplitPanel 内部渲染，避免拖拽状态需要跨层暴露给 App.tsx */}
      <SplitPanelDivider
        isDragging={resizeManager.isDragging}
        onMouseDown={resizeManager.handleMouseDown}
        visible={isVisible}
      />
      <div className={containerClassName} data-testid="split-panel" style={containerStyle}>
      {/* 工具栏 */}
      <SplitPanelToolbar
        tabs={tabsManager.tabs}
        activeTabId={tabsManager.activeTabId}
        layout={tabsManager.layout}
        canChangeLayout={canChangeLayout}
        cliEnablement={cliEnablement}
        onActivateTab={handleActivateTab}
        onCloseTab={handleCloseTab}
        onCloseAllTabs={handleCloseAllTabs}
        onCreateSession={handleCreateSession}
        onChangeLayout={handleChangeLayout}
        onClosePanel={handleClosePanel}
        onRestartActive={handleRestartActive}
      />

      {/* Canvas 布局 */}
      <SplitPanelCanvas
        layout={tabsManager.layout}
        paneAssignment={tabsManager.paneAssignment}
        tabs={tabsManager.tabs}
        activeTabId={tabsManager.activeTabId}
        workspace={workspace}
        surfaceBgColor={surfaceBgColor}
        onPaneActivate={handlePaneActivate}
        onCloseTab={handleCloseTab}
        onSessionActiveChange={handleSessionActiveChange}
        onSessionClosed={handleSessionClosed}
        onRegisterRestart={handleRegisterRestart}
      />

      {/* 工作目录绑定指示器 */}
      {showCwdIndicator && (
        <WorkspaceBindingIndicator
          bindingMode={{ kind: "follow-workspace" }}
          currentPath={workspacePath}
          detailed={true}
        />
      )}
      </div>
    </>
  );
}

export { type SplitPanelTab, type CliType, type SplitLayout } from "./types";
export { useSplitPanelTabs } from "../hooks/use-split-panel-tabs";
export { useSplitPanelResize } from "../hooks/use-split-panel-resize";
