/**
 * @fileoverview CLI 专用错误类型与重试策略表
 */

import { CliType } from "./types.js";

/** CLI 未安装错误 */
export class CliNotInstalledError extends Error {
  constructor(cliType: CliType, message?: string) {
    super(message ?? `${cliType} CLI is not installed`);
    this.name = "CliNotInstalledError";
  }
}

/** CLI 认证失败错误 */
export class CliAuthError extends Error {
  constructor(cliType: CliType, message?: string) {
    super(message ?? `${cliType} CLI authentication failed. Check API key.`);
    this.name = "CliAuthError";
  }
}

/** CLI spawn 错误 */
export class CliSpawnError extends Error {
  public readonly exitCode: number | null;
  public readonly stderr: string;

  constructor(cliType: CliType, exitCode: number | null, stderr: string, message?: string) {
    super(message ?? `${cliType} CLI process exited with code ${exitCode ?? "unknown"}`);
    this.name = "CliSpawnError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** CLI 超时错误 */
export class CliTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(cliType: CliType, timeoutMs: number) {
    super(`${cliType} CLI timed out after ${timeoutMs}ms`);
    this.name = "CliTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** CLI 不支持的平台错误 */
export class CliUnsupportedPlatformError extends Error {
  constructor(cliType: CliType, platform: string) {
    super(`${cliType} CLI does not support platform: ${platform}`);
    this.name = "CliUnsupportedPlatformError";
  }
}

/** 重试策略 */
export interface RetryStrategy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly backoff: "exponential" | "fixed";
}

/** 各 CLI 的重试策略表 */
export const CLI_RETRY_STRATEGIES: Record<CliType, RetryStrategy> = {
  [CliType.CodeX]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.ClaudeCode]: { maxRetries: 3, baseDelayMs: 2000, backoff: "exponential" },
  [CliType.OpenCode]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Grok]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Copilot]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Antigravity]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Kiro]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Cursor]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
  [CliType.Droid]: { maxRetries: 2, baseDelayMs: 1000, backoff: "exponential" },
};

/**
 * 执行带重试的异步操作
 * @param fn 需要重试的异步函数
 * @param strategy 重试策略
 * @param onRetry 每次重试前的回调（可选）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  strategy: RetryStrategy,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < strategy.maxRetries) {
        onRetry?.(attempt + 1, lastError);
        const delay = strategy.backoff === "exponential"
          ? strategy.baseDelayMs * Math.pow(2, attempt)
          : strategy.baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
