/**
 * @fileoverview CliAdapter 抽象接口 — 所有 CLI 适配器必须实现
 */

import type { CliBackgroundSession, CliDetectionResult, CliEvent, CliSpawnConfig, CliType, KillStep } from "./types.js";

/**
 * CLI 适配器 — 统一抽象接口
 *
 * 所有 CLI 适配器（CodeX、Claude Code、OpenCode）必须实现此接口。
 * 使用适配器模式+策略模式，将各 CLI 的差异封装在适配器内部。
 */
export interface CliAdapter {
  /** CLI 类型标识 */
  readonly cliType: CliType;

  /** 人类可读名称（用于 UI 展示） */
  readonly displayName: string;

  // ── 安装检测 ──

  /**
   * 检测 CLI 是否已安装
   * 返回二进制路径、版本、安装来源
   */
  detect(): Promise<CliDetectionResult>;

  /**
   * 检查 API 密钥/认证是否就绪
   */
  checkAuth(): Promise<boolean>;

  // ── 启动与执行 ──

  /**
   * 构建交互式 TUI 会话的 spawn 命令（通过 node-pty）
   * 返回启动命令、参数和环境变量
   */
  buildTuiSpawnCommand(config: CliSpawnConfig): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string | undefined>;
  };

  /**
   * 启动 headless 非交互执行
   * 返回统一事件流（AsyncIterable）
   */
  executeHeadless(config: CliSpawnConfig): AsyncIterable<CliEvent>;

  /**
   * 启动后台 session（若 CLI 支持，不支持则 throw）
   */
  startBackgroundSession(prompt: string, cwd: string): Promise<string>;

  // ── 会话管理 ──

  /** 列出所有后台 session */
  listBackgroundSessions(): Promise<readonly CliBackgroundSession[]>;

  /** 附着到后台 session 的事件流 */
  attachToSession(sessionId: string): AsyncIterable<CliEvent>;

  /** 停止后台 session */
  stopSession(sessionId: string): Promise<void>;

  /** 获取 session 日志 */
  getSessionLogs(sessionId: string): Promise<string>;

  // ── 进程管理 ──

  /** 检查 CLI 进程是否仍在运行 */
  isProcessAlive(pid: number): boolean;

  /**
   * 构建进程终止步骤（优雅 → 强制）
   * 返回有序的 KillStep 数组
   */
  buildKillSequence(): readonly KillStep[];

  // ── 平台适配 ──

  /** 获取支持的平台列表 */
  supportedPlatforms(): readonly string[];

  /** 是否需要特殊 spawn workaround */
  requiresSpawnWorkaround(): boolean;

  /**
   * 构建 spawn 调用（处理平台特定 workaround）
   * 例如 Windows 上 Claude Code 需要 cmd /c 包装
   */
  buildSpawnInvocation(
    command: string,
    args: readonly string[],
  ): { readonly command: string; readonly args: readonly string[] };
}
