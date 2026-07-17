/**
 * ============================================================
 * SplitPanelPane — 单个分屏 Pane 组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §4 分栏布局系统
 *
 * 职责:
 * - 承载真实的 CLI 终端会话（直接复用 TerminalPanel，不重复实现 xterm.js 管道）
 * - 空状态占位符
 *
 * 说明:
 * 该组件刻意保持"薄" — 所有终端生命周期（PTY 派生、IPC 订阅、xterm 挂载/
 * 卸载、resize、重放）都完全委托给 <TerminalPanel>，本文件只负责：
 * 1. 根据 tab.cliType 构造 TerminalLaunchConfig；
 * 2. 把 TerminalPanel 的会话状态变更回传给上层 Tab 状态管理（useSplitPanelTabs）。
 *
 * 注：每个 CLI 的标题/状态/切换已由顶层的 split-panel toolbar 统一承载，
 * 本 Pane 不再渲染独立的迷你 header，避免与 TerminalPanel 自身工具栏重复堆叠。
 */

import React, { useCallback } from "react";
import type { WorkspaceRecord } from "../desktop-state";
import type { TerminalLaunchConfig, TerminalSessionSnapshot } from "../ipc";
import { TerminalPanel } from "../terminal-panel";
import { useI18n } from "../i18n";
import type { CliType, SplitPanelTab, SplitLayout } from "./types";

export interface SplitPanelPaneProps {
  /** Pane 索引 */
  readonly paneIndex: number;

  /** 分配到该 Pane 的 Tab（null = 空） */
  readonly tab: SplitPanelTab | null;

  /** 当前布局模式 */
  readonly layout: SplitLayout;

  /** 是否为当前激活的 Pane */
  readonly isActive: boolean;

  /** 当前工作区（用于派生 PTY，follow-workspace 模式下随左侧工作区变化） */
  readonly workspace: WorkspaceRecord | null;

  /** Light-theme surface background for the embedded adaptive terminal. */
  readonly surfaceBgColor?: string;

  /** 点击 Pane 回调 */
  readonly onActivate?: (paneIndex: number) => void;

  /**
   * 关闭该 Pane 对应 Tab 的回调 — 由 Pane 内 <TerminalPanel> 右上角
   * "关闭终端" 按钮触发。语义与顶部工具栏 Tab 上的 × 完全一致：关闭 Tab
   * 并由上层 (App.tsx) 通过 onTabClosed 链路终结后端 PTY 子进程组。
   */
  readonly onCloseTab?: (tabId: string) => void;

  /** 终端会话激活/切换回调（用于同步 Tab 的 sessionId / status） */
  readonly onSessionActiveChange?: (tabId: string, session: TerminalSessionSnapshot) => void;

  /** 终端会话关闭回调（用于把 Tab 标记为 completed / killed） */
  readonly onSessionClosed?: (
    tabId: string,
    closedSession: TerminalSessionSnapshot,
    nextActiveSession: TerminalSessionSnapshot | undefined,
  ) => void;

  /**
   * 注册/注销指定 Tab 的终端重启函数 — 由内嵌 TerminalPanel 在挂载时
   * 调用，供 SplitPanelToolbar 的 "重启" 按钮经 SplitPanel → active tab
   * 查找到对应函数后触发。
   */
  readonly onRegisterRestart?: (
    tabId: string,
    fn: (() => void) | null,
  ) => void;
}

// ── CLI 类型显示信息 ──
// 注：CLI 标题/指示色已由顶层 split-panel toolbar 统一渲染，Pane 内不再保留。

/**
 * 根据 CLI 类型构造对应的远程 TUI 启动配置。
 * 与现有的 pi-tui 模式保持同一套 TerminalLaunchConfig 协议，
 * 由主进程 TerminalService.resolveCliLaunchCommand 负责实际的可执行文件探测与拼装。
 */
function buildCliLaunchConfig(cliType: CliType, prompt?: string): TerminalLaunchConfig {
  return { mode: cliType, prompt };
}

/**
 * 单个分屏 Pane 组件
 */
export function SplitPanelPane({
  paneIndex,
  tab,
  layout,
  isActive,
  workspace,
  surfaceBgColor,
  onActivate,
  onCloseTab,
  onSessionActiveChange,
  onSessionClosed,
  onRegisterRestart,
}: SplitPanelPaneProps) {
  const { t } = useI18n();
  // 点击 Pane 激活
  const handleClick = () => {
    onActivate?.(paneIndex);
  };

  // ── 空状态 Pane ──

  if (!tab) {
    const paneClass = [
      "split-panel__pane",
      "split-panel__pane--empty",
      isActive ? "split-panel__pane--active" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={paneClass} onClick={handleClick} data-pane-index={paneIndex}>
        <div className="split-panel__pane-empty-placeholder">
          <div className="split-panel__pane-empty-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M5 7h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="split-panel__pane-empty-text">
            {t("splitPanel.emptyPlaceholder")}
          </div>
        </div>
      </div>
    );
  }

  // ── 有内容的 Pane ──

  const paneClass = [
    "split-panel__pane",
    isActive ? "split-panel__pane--active" : "",
    tab.status === "pending" || tab.status === "starting" ? "split-panel__pane--loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 每个 Tab 拥有独立且稳定的 terminalScopeId，确保多分屏下 PTY 数据流不会串线。
  const terminalScopeId = `split-panel:${tab.id}`;

  // 把 TerminalPanel 的 registerRestart(fn) 包装为 onRegisterRestart(tab.id, fn)，
  // 让上层 SplitPanel 能按 tabId 索引到对应终端的重启函数。
  const handleRegisterRestart = useCallback(
    (fn: (() => void) | null) => {
      onRegisterRestart?.(tab.id, fn);
    },
    [onRegisterRestart, tab.id],
  );

  return (
    <div className={paneClass} onClick={handleClick} data-pane-index={paneIndex}>
      {/* 终端容器：直接复用 TerminalPanel，承载真实的远程 TUI 会话 */}
      <div className="split-panel__pane-terminal" data-terminal-container={`pane-${paneIndex}`}>
        {workspace ? (
          <TerminalPanel
            key={tab.id}
            workspace={workspace}
            sessionId={tab.sessionId ?? tab.id}
            terminalScopeId={terminalScopeId}
            launchConfig={buildCliLaunchConfig(tab.cliType, tab.prompt)}
            height={0}
            isTakeover
            allowMultipleSessions={false}
            allowCreateSession={false}
            closeOnHide={false}
            adaptiveTheme={true}
            surfaceBgColor={surfaceBgColor}
            isActive={isActive}
            hideToolbar
            registerRestart={handleRegisterRestart}
            testId={`split-panel-terminal-${tab.id}`}
            onHeightChange={() => {}}
            onToggleTakeover={() => {}}
            onHide={() => {
              // 右上角 "关闭终端" 按钮：路由到与工具栏 × 相同的 Tab 关闭路径，
              // 由 App.tsx 的 onTabClosed 终结后端 PTY 子进程组。
              // 保持 closeOnHide={false}，避免 TerminalPanel 内部再单独调
              // closeTerminal 造成与 App.tsx 的双重 kill。
              onCloseTab?.(tab.id);
            }}
            onActiveSessionChange={(session) => {
              onSessionActiveChange?.(tab.id, session);
            }}
            onSessionClosed={(closedSession, nextActiveSession) => {
              onSessionClosed?.(tab.id, closedSession, nextActiveSession);
            }}
          />
        ) : (
          <div className="split-panel__pane-empty-placeholder">
            <div className="split-panel__pane-empty-text">{t("splitPanel.workspaceNotReady")}</div>
          </div>
        )}
      </div>
    </div>
  );
}
