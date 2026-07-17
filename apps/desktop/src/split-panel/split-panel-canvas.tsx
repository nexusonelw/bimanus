/**
 * ============================================================
 * SplitPanelCanvas — 分屏画布（Grid 布局容器）组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §4 分栏布局系统
 *
 * 职责:
 * - 根据 SplitLayout 渲染对应的 Grid 布局
 * - 管理子 Pane 的排布
 * - 处理布局切换的动画过渡
 */

import React, { useCallback } from "react";
import type { WorkspaceRecord } from "../desktop-state";
import type { TerminalSessionSnapshot } from "../ipc";
import type { SplitLayout, SplitPanelTab } from "./types";
import { getLayoutGridTemplate } from "./types";
import { SplitPanelPane, type SplitPanelPaneProps } from "./split-panel-pane";

export interface SplitPanelCanvasProps {
  /** 当前布局模式 */
  readonly layout: SplitLayout;

  /** Pane 分配列表（每个 Pane 对应的 Tab ID） */
  readonly paneAssignment: readonly (string | null)[];

  /** 所有 Tab */
  readonly tabs: readonly SplitPanelTab[];

  /** 当前激活的 Tab ID */
  readonly activeTabId: string | null;

  /** 当前工作区（用于派生 PTY，透传给每个 Pane 内部的 TerminalPanel） */
  readonly workspace?: WorkspaceRecord | null;

  /** Light-theme surface background for nested adaptive terminals. */
  readonly surfaceBgColor?: string;

  /** 点击 Pane 回调 */
  readonly onPaneActivate?: (paneIndex: number) => void;

  /**
   * 关闭 Pane 对应 Tab 的回调 — 透传给每个 Pane 内 <TerminalPanel> 的
   * 右上角 "关闭终端" 按钮，使其与工具栏 × 走同一条 Tab 关闭路径。
   */
  readonly onCloseTab?: (tabId: string) => void;

  /** 终端会话激活/切换回调（透传给每个 Pane，回写对应 Tab 的会话状态） */
  readonly onSessionActiveChange?: (tabId: string, session: TerminalSessionSnapshot) => void;

  /** 终端会话关闭回调（透传给每个 Pane，回写对应 Tab 的会话状态） */
  readonly onSessionClosed?: (
    tabId: string,
    closedSession: TerminalSessionSnapshot,
    nextActiveSession: TerminalSessionSnapshot | undefined,
  ) => void;

  /**
   * 注册/注销终端重启函数 — 透传给每个 Pane 内 <TerminalPanel>，
   * 供 SplitPanelToolbar 的 "重启" 按钮调用当前激活 Tab 的终端重启。
   */
  readonly onRegisterRestart?: (
    tabId: string,
    fn: (() => void) | null,
  ) => void;

  /** 获取 Tab 对应的 pane 索引 */
  readonly getPaneIndexForTab?: (tabId: string) => number;
}

/**
 * 根据 layout 生成 CSS class name
 */
function getLayoutClassName(layout: SplitLayout): string {
  switch (layout) {
    case "single": return "split-panel__canvas--single";
    case "dual":   return "split-panel__canvas--dual";
    case "quad":   return "split-panel__canvas--quad";
    case "grid4":  return "split-panel__canvas--grid4";
  }
}

/**
 * 分屏画布组件
 *
 * 以 CSS Grid 布局渲染所有 Pane。
 * 支持的布局:
 * - single: 1 列 1 行
 * - dual:   2 列 1 行
 * - quad:   2 列 1 行（2 个 pane 等宽）
 * - grid4:  2 列 2 行（田字格）
 */
export function SplitPanelCanvas({
  layout,
  paneAssignment,
  tabs,
  activeTabId,
  workspace = null,
  surfaceBgColor,
  onPaneActivate,
  onCloseTab,
  onSessionActiveChange,
  onSessionClosed,
  onRegisterRestart,
  getPaneIndexForTab,
}: SplitPanelCanvasProps) {
  const paneCount = paneAssignment.length;

  // 查找指定 paneIndex 对应的 Tab
  const getTabForPane = useCallback(
    (tabId: string | null): SplitPanelTab | null => {
      if (!tabId) return null;
      return tabs.find((t) => t.id === tabId) ?? null;
    },
    [tabs],
  );

  // 确定 pane 数量（至少 1）
  const effectivePaneCount = Math.max(1, paneCount);

  // 构建 Pane 数组
  const panes = Array.from({ length: effectivePaneCount }, (_, i) => {
    const tabId = paneAssignment[i] ?? null;
    const tab = getTabForPane(tabId);
    const isActive = tabId !== null && tabId === activeTabId;

    return (
      <SplitPanelPane
        key={`pane-${i}`}
        paneIndex={i}
        tab={tab}
        layout={layout}
        isActive={isActive}
        workspace={workspace}
        surfaceBgColor={surfaceBgColor}
        onActivate={onPaneActivate}
        onCloseTab={onCloseTab}
        onSessionActiveChange={onSessionActiveChange}
        onSessionClosed={onSessionClosed}
        onRegisterRestart={onRegisterRestart}
      />
    );
  });

  const canvasClassName = [
    "split-panel__canvas",
    getLayoutClassName(layout),
  ].join(" ");

  return (
    <div className={canvasClassName} data-layout={layout} data-pane-count={effectivePaneCount}>
      {panes}
    </div>
  );
}
