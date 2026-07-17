/**
 * ============================================================
 * SplitPanel — 右侧分屏面板类型定义
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §3 Tab 管理系统
 *
 * 本文件定义分屏面板的所有数据模型，包括：
 * - SplitPanelTab — 分屏会话 Tab
 * - TabSessionStatus — 会话状态枚举
 * - SplitLayout — 布局模式枚举
 * - SplitPanelState — 分屏面板完整状态
 * - CwdBindingMode — 工作目录绑定模式
 * - CreateTabConfig — 创建新 Tab 的配置
 */

// ── CLI 类型 ──

/** 支持的 CLI 类型 */
export type CliType =
  | "codex"
  | "claude"
  | "opencode"
  | "grok"
  | "copilot"
  | "antigravity"
  | "kiro"
  | "cursor"
  | "droid";

// ── Tab 状态 ──

/** Tab 会话状态 */
export type TabSessionStatus =
  | "pending"    // 创建中
  | "starting"   // CLI 启动中
  | "active"     // 运行中
  | "idle"       // 空闲（等待输入）
  | "error"      // 异常
  | "completed"  // 正常结束
  | "killed";    // 被终止

// ── Tab 数据模型 ──

/** 分屏会话 Tab */
export interface SplitPanelTab {
  /** 唯一标识 */
  readonly id: string;

  /** 人类可读标题（自动生成："CodeX #1" / "Claude #2"） */
  title: string;

  /** CLI 类型 */
  readonly cliType: CliType;

  /** 绑定的工作目录 */
  cwd: string;

  /** 会话 ID（由 CLI 分配） */
  sessionId: string | null;

  /** 初始提示 */
  readonly prompt?: string;

  /** PTY 进程 PID */
  pid: number | null;

  /** 会话状态 */
  status: TabSessionStatus;

  /** 最后访问时间戳（用于 LRU 淘汰） */
  lastAccessedAt: number;

  /** 创建时间戳 */
  readonly createdAt: number;
}

// ── 布局 ──

/** 布局模式 */
export type SplitLayout = "single" | "dual" | "quad" | "grid4";

// ── 工作目录绑定模式 ──

/** 工作目录绑定模式 */
export type CwdBindingMode =
  | { kind: "follow-workspace" }       // 默认跟随左侧当前工作区
  | { kind: "manual"; path: string };  // 手动指定固定路径

// ── Pane 分配 ──

/** Pane 位置索引 */
export interface PanePosition {
  readonly row: number;
  readonly col: number;
}

// ── 完整状态 ──

/** 分屏面板的完整状态 */
export interface SplitPanelState {
  /** 当前布局模式 */
  layout: SplitLayout;

  /** 所有 Tab */
  tabs: SplitPanelTab[];

  /** 当前激活的 Tab ID */
  activeTabId: string | null;

  /** Pane 阵型: 每个 Pane 对应一个 Tab ID (null = 空) */
  paneAssignment: (string | null)[];
}

// ── 创建 Tab 配置 ──

/** 创建新 Tab 的配置 */
export interface CreateTabConfig {
  cliType: CliType;
  id?: string;
  cwd?: string;           // 未指定则跟随 CwdBindingMode
  prompt?: string;        // 初始提示（可选）
}

// ── 默认值 ──

/** 默认分屏面板宽度 */
export const DEFAULT_SPLIT_PANEL_WIDTH = 600;

/** 最小分屏面板宽度 */
export const MIN_SPLIT_PANEL_WIDTH = 400;

/** 最大分屏面板宽度 */
export const MAX_SPLIT_PANEL_WIDTH = 1200;

/** 创建默认分屏面板状态 */
export function createDefaultSplitPanelState(): SplitPanelState {
  return {
    layout: "single",
    tabs: [],
    activeTabId: null,
    paneAssignment: [],
  };
}

// ── 布局工具函数 ──

/** 根据布局模式获取 Pane 数量 */
export function getPaneCountForLayout(layout: SplitLayout): number {
  switch (layout) {
    case "single": return 1;
    case "dual":   return 2;
    case "quad":   return 2; // quad 也是 2 列，但 2 个 pane
    case "grid4":  return 4;
  }
}

/** 获取布局的 CSS grid-template 描述 */
export function getLayoutGridTemplate(layout: SplitLayout): {
  columns: string;
  rows: string;
} {
  switch (layout) {
    case "single":
      return { columns: "1fr", rows: "1fr" };
    case "dual":
      return { columns: "1fr 1fr", rows: "1fr" };
    case "quad":
      return { columns: "1fr 1fr", rows: "1fr" };
    case "grid4":
      return { columns: "1fr 1fr", rows: "1fr 1fr" };
  }
}

/** 根据布局和 Pane 索引计算位置 */
export function getPanePosition(layout: SplitLayout, paneIndex: number): PanePosition {
  switch (layout) {
    case "single":
      return { row: 1, col: 1 };
    case "dual":
      return { row: 1, col: paneIndex + 1 };
    case "quad":
      return { row: 1, col: paneIndex + 1 };
    case "grid4":
      return { row: Math.floor(paneIndex / 2) + 1, col: (paneIndex % 2) + 1 };
  }
}
