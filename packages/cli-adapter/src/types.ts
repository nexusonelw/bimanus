/**
 * @fileoverview 核心类型定义 — CLI 适配器包共享的所有类型
 */

/** CLI 类型枚举 */
export enum CliType {
  CodeX = "codex",
  ClaudeCode = "claude",
  OpenCode = "opencode",
  Grok = "grok",
  Copilot = "copilot",
  Antigravity = "antigravity",
  Kiro = "kiro",
  Cursor = "cursor",
  Droid = "droid",
}

/** CLI 安装检测结果 */
export interface CliDetectionResult {
  /** 是否已安装 */
  readonly installed: boolean;
  /** 二进制完整路径（若已安装） */
  readonly binaryPath: string | null;
  /** 版本号（若可用） */
  readonly version: string | null;
  /** 安装方式 */
  readonly installSource: "standalone" | "npm" | "homebrew" | "unknown" | null;
  /** 错误信息（若检测过程中出现异常） */
  readonly error: string | null;
}

/** CLI 进程启动配置 */
export interface CliSpawnConfig {
  /** 工作目录 */
  readonly cwd: string;
  /** 提示/任务文本 */
  readonly prompt: string;
  /** 输出格式 */
  readonly outputFormat: "text" | "json" | "stream-json";
  /** 环境变量覆盖 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 超时（毫秒） */
  readonly timeoutMs?: number;
  /** 最大交互轮数（仅 Claude Code） */
  readonly maxTurns?: number;
  /** 最大预算（美元） */
  readonly maxBudgetUsd?: number;
  /** 权限模式 */
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  /** 允许的工具列表（仅 Claude Code） */
  readonly allowedTools?: readonly string[];
  /** 禁止的工具列表（仅 Claude Code） */
  readonly disallowedTools?: readonly string[];
  /** 沙箱级别（仅 CodeX） */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** 裸模式，跳过自动发现（仅 Claude Code） */
  readonly bare?: boolean;
  /** 临时模式，不持久化 session（仅 CodeX） */
  readonly ephemeral?: boolean;
  /** Optional explicit port for CLIs that start a local HTTP server (e.g., OpenCode) */
  readonly port?: number;
}

/** CLI 进程输出事件（统一事件类型） */
export type CliEvent =
  | { readonly type: "started"; readonly timestamp: number }
  | { readonly type: "agent_message"; readonly content: string; readonly timestamp: number }
  | { readonly type: "reasoning"; readonly content: string; readonly timestamp: number }
  | { readonly type: "command_execution"; readonly command: string; readonly exitCode: number | null; readonly output: string; readonly status: "started" | "completed" | "failed"; readonly timestamp: number }
  | { readonly type: "file_change"; readonly path: string; readonly kind: "add" | "delete" | "update"; readonly status: "pending" | "applied" | "rejected"; readonly timestamp: number }
  | { readonly type: "tool_call"; readonly toolName: string; readonly arguments: unknown; readonly result: unknown; readonly timestamp: number }
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean; readonly timestamp: number }
  | { readonly type: "progress"; readonly message: string; readonly timestamp: number }
  | { readonly type: "completed"; readonly sessionId: string | null; readonly totalCostUsd?: number; readonly timestamp: number };

/** Kill 步骤 */
export interface KillStep {
  readonly signal: string;
  readonly timeoutMs: number;
  readonly description: string;
}

/** 后台 session 信息 */
export interface CliBackgroundSession {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "paused" | "completed" | "failed";
  readonly createdAt: number;
  readonly lastActiveAt: number;
}
