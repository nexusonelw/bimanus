/**
 * @fileoverview Electron 主进程 CLI 检测服务
 *
 * 职责：在 Electron 主进程中运行 CLI 检测（通过 CliAdapterRegistry）。
 * CLI 检测涉及文件系统访问和子进程执行 (--version)，
 * 不适合在渲染进程执行。
 */

import path from "node:path";
import {
  CliAdapterRegistry,
  CliType,
  classifyInstallSource,
  findExecutable,
  getDetectionCommand,
  type CliDetectionResult as AdapterCliDetectionResult,
} from "@bimanus/cli-adapter";
import type { CliAdapterInfo, CliDetectionMap, CliDetectionResult } from "../src/ipc";

const DETECTION_CACHE_TTL_MS = 5 * 60_000;

type CliRegistry = Pick<CliAdapterRegistry, "getAdapter" | "getSupportedTypes">;
type ExecutableResolver = (command: string) => string | null;

interface CachedDetection {
  readonly result: AdapterCliDetectionResult;
  readonly expiresAt: number;
}

export interface ExternalCliLaunchCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cliPort?: number;
}

/**
 * CLI 检测器 — 主进程服务
 *
 * 封装 CliAdapterRegistry 的检测逻辑，提供统一的检测接口
 * 供 Electron IPC handlers 调用。
 */
export class CliDetector {
  private readonly cache = new Map<CliType, CachedDetection>();
  private readonly pending = new Map<CliType, Promise<AdapterCliDetectionResult>>();

  constructor(
    private readonly registry: CliRegistry = CliAdapterRegistry.getInstance(),
    private readonly resolveExecutable: ExecutableResolver = findExecutable,
    private readonly cacheTtlMs = DETECTION_CACHE_TTL_MS,
  ) {}

  /**
   * 检测所有已注册的 CLI
   * @returns CLI 类型 → 检测结果的映射
   */
  async detectAll(): Promise<CliDetectionMap> {
    const results = await Promise.all(
      this.registry.getSupportedTypes().map(async (cliType) => [cliType, await this.detect(cliType)] as const),
    );
    const map: CliDetectionMap = {};
    for (const [cliType, result] of results) {
      map[cliType] = result;
    }
    return map;
  }

  /**
   * 检测单个 CLI
   * @param cliTypeStr CLI 类型字符串
   * @returns 检测结果
   */
  async detectOne(cliTypeStr: string): Promise<CliDetectionResult> {
    const cliType = this.parseCliType(cliTypeStr);
    if (!cliType) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        installSource: null,
        error: `Unknown CLI type: ${cliTypeStr}`,
      };
    }

    return this.detect(cliType);
  }

  /**
   * Resolve a PTY launch synchronously from a validated cache or the local PATH.
   * Version probing is refreshed in the background and never blocks terminal startup.
   */
  resolveLaunchCommand(
    cliTypeStr: string,
    prompt: string,
    cliPort?: number,
  ): ExternalCliLaunchCommand {
    const cliType = this.parseCliType(cliTypeStr);
    if (!cliType) {
      throw new Error(`Unknown CLI type: ${cliTypeStr}`);
    }

    const adapter = this.registry.getAdapter(cliType);
    const command = getDetectionCommand(cliType);
    const binaryPath = this.cachedExecutable(cliType) ?? this.resolveExecutable(command);
    this.refreshInBackground(cliType);

    if (!binaryPath || !path.isAbsolute(binaryPath)) {
      throw new Error(
        `${adapter.displayName} executable "${command}" was not found in PATH or standard CLI directories `
        + `(including ~/.local/bin). Install its CLI separately or add the executable to PATH.`,
      );
    }

    const spawnCommand = adapter.buildTuiSpawnCommand({
      cwd: "",
      prompt,
      outputFormat: "text",
      ...(cliPort !== undefined ? { port: cliPort } : {}),
    });
    return {
      file: binaryPath,
      args: [...spawnCommand.args],
      ...(cliPort !== undefined ? { cliPort } : {}),
    };
  }

  /**
   * 获取所有适配器的信息
   */
  getAdapterInfo(): CliAdapterInfo[] {
    const types = this.registry.getSupportedTypes();
    return types.map((cliType) => {
      try {
        const adapter = this.registry.getAdapter(cliType);
        return {
          cliType: adapter.cliType,
          displayName: adapter.displayName,
          installed: this.cache.get(cliType)?.result.installed ?? false,
          supported: true,
        };
      } catch {
        return {
          cliType: cliType,
          displayName: cliType,
          installed: false,
          supported: false,
        };
      }
    });
  }

  /**
   * 将字符串解析为 CliType 枚举
   */
  private parseCliType(str: string): CliType | null {
    const normalized = str.toLowerCase().trim();
    switch (normalized) {
      case "codex":
        return CliType.CodeX;
      case "claude":
      case "claude-code":
        return CliType.ClaudeCode;
      case "opencode":
        return CliType.OpenCode;
      case "grok":
        return CliType.Grok;
      case "copilot":
        return CliType.Copilot;
      case "antigravity":
      case "agy":
        return CliType.Antigravity;
      case "kiro":
      case "kiro-cli":
        return CliType.Kiro;
      case "cursor":
      case "cursor-agent":
        return CliType.Cursor;
      case "droid":
        return CliType.Droid;
      default:
        return null;
    }
  }

  private async detect(cliType: CliType): Promise<AdapterCliDetectionResult> {
    const cached = this.cache.get(cliType);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const inFlight = this.pending.get(cliType);
    if (inFlight) {
      return inFlight;
    }

    const adapter = this.registry.getAdapter(cliType);
    const detection = Promise.resolve()
      .then(() => adapter.detect())
      .catch((error): AdapterCliDetectionResult => ({
        installed: false,
        binaryPath: null,
        version: null,
        installSource: null,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        const normalized = this.normalizeDetection(result);
        this.cache.set(cliType, { result: normalized, expiresAt: Date.now() + this.cacheTtlMs });
        return normalized;
      });
    this.pending.set(cliType, detection);
    try {
      return await detection;
    } finally {
      if (this.pending.get(cliType) === detection) {
        this.pending.delete(cliType);
      }
    }
  }

  private cachedExecutable(cliType: CliType): string | null {
    const binaryPath = this.cache.get(cliType)?.result.binaryPath;
    return binaryPath ? this.resolveExecutable(binaryPath) : null;
  }

  private refreshInBackground(cliType: CliType): void {
    const cached = this.cache.get(cliType);
    if (cached && cached.expiresAt > Date.now()) {
      return;
    }
    void this.detect(cliType);
  }

  private normalizeDetection(result: AdapterCliDetectionResult): AdapterCliDetectionResult {
    if (!result.installed || !result.binaryPath) {
      return result;
    }
    const binaryPath = this.resolveExecutable(result.binaryPath);
    if (!binaryPath || !path.isAbsolute(binaryPath)) {
      return {
        installed: false,
        binaryPath: null,
        version: result.version,
        installSource: null,
        error: result.error ?? `Detected CLI path is not executable: ${result.binaryPath}`,
      };
    }
    return {
      ...result,
      binaryPath,
      installSource: result.installSource ?? classifyInstallSource(binaryPath),
    };
  }
}
