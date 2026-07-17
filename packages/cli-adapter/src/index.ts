/**
 * @fileoverview @bimanus/cli-adapter 公共导出
 */

// ── 类型导出 ──
export type { CliAdapter } from "./cli-adapter.js";
export { CliType } from "./types.js";
export type {
  CliBackgroundSession,
  CliDetectionResult,
  CliEvent,
  CliSpawnConfig,
  KillStep,
} from "./types.js";

// ── 错误类型 ──
export {
  CliNotInstalledError,
  CliAuthError,
  CliSpawnError,
  CliTimeoutError,
  CliUnsupportedPlatformError,
  CLI_RETRY_STRATEGIES,
  withRetry,
} from "./cli-errors.js";
export type { RetryStrategy } from "./cli-errors.js";

// ── 工具函数 ──
export {
  buildSpawnInvocation,
  requiresSpawnWorkaround,
  getDetectionCommand,
  getVersionArgs,
  classifyInstallSource,
  findExecutable,
} from "./spawn-utils.js";
export type { FindExecutableOptions } from "./spawn-utils.js";

// ── 注册表 ──
export { CliAdapterRegistry } from "./cli-adapter-registry.js";

// ── 适配器实现 ──
export { CodeXAdapter } from "./codex-adapter.js";
export { ClaudeCodeAdapter } from "./claude-code-adapter.js";
export { OpenCodeAdapter } from "./opencode-adapter.js";
export { GenericTuiAdapter } from "./generic-tui-adapter.js";
