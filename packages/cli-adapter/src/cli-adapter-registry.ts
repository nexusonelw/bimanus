/**
 * @fileoverview CLI 适配器注册表与工厂
 *
 * 使用单例模式 + 延迟创建 + 缓存。
 * 支持注册、获取、批量检测所有适配器。
 */

import type { CliAdapter } from "./cli-adapter.js";
import type { CliDetectionResult } from "./types.js";
import { CliType } from "./types.js";
import { CodeXAdapter } from "./codex-adapter.js";
import { ClaudeCodeAdapter } from "./claude-code-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { GenericTuiAdapter } from "./generic-tui-adapter.js";

/**
 * CLI 适配器注册表 — 单例
 *
 * 职责：
 * 1. register(cliType, factory) — 注册适配器工厂
 * 2. getAdapter(cliType) — 获取适配器实例（延迟创建 + 缓存）
 * 3. detectAll() — 批量检测所有已注册 CLI
 * 4. getSupportedTypes() — 列出所有已注册 CLI 类型
 */
export class CliAdapterRegistry {
  private static instance: CliAdapterRegistry;

  /** 工厂函数映射 */
  private readonly factories = new Map<CliType, () => CliAdapter>();

  /** 缓存的适配器实例 */
  private readonly instances = new Map<CliType, CliAdapter>();

  private constructor() {
    // 默认注册所有内置适配器
    this.registerDefaultAdapters();
  }

  /** 获取单例实例 */
  static getInstance(): CliAdapterRegistry {
    if (!CliAdapterRegistry.instance) {
      CliAdapterRegistry.instance = new CliAdapterRegistry();
    }
    return CliAdapterRegistry.instance;
  }

  /** 重置单例（测试用） */
  static resetInstance(): void {
    CliAdapterRegistry.instance = new CliAdapterRegistry();
  }

  /**
   * 注册适配器工厂
   * @param cliType CLI 类型
   * @param factory 工厂函数，返回适配器实例
   */
  register(cliType: CliType, factory: () => CliAdapter): void {
    if (this.factories.has(cliType)) {
      throw new Error(`Adapter already registered for CLI type: ${cliType}`);
    }
    this.factories.set(cliType, factory);
    // 清除已缓存的实例（如果有）
    this.instances.delete(cliType);
  }

  /**
   * 获取适配器实例（延迟创建 + 缓存）
   * @param cliType CLI 类型
   * @throws 如果该类型未注册
   */
  getAdapter(cliType: CliType): CliAdapter {
    const cached = this.instances.get(cliType);
    if (cached) return cached;

    const factory = this.factories.get(cliType);
    if (!factory) {
      throw new Error(`No adapter registered for CLI type: ${cliType}`);
    }

    const adapter = factory();
    this.instances.set(cliType, adapter);
    return adapter;
  }

  /**
   * 批量检测所有已注册 CLI
   * @returns CLI 类型 → 检测结果的 Map
   */
  async detectAll(): Promise<Map<CliType, CliDetectionResult>> {
    const results = new Map<CliType, CliDetectionResult>();
    const promises: Promise<void>[] = [];

    for (const cliType of this.factories.keys()) {
      promises.push(
        (async () => {
          try {
            const adapter = this.getAdapter(cliType);
            const result = await adapter.detect();
            results.set(cliType, result);
          } catch (error) {
            results.set(cliType, {
              installed: false,
              binaryPath: null,
              version: null,
              installSource: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })(),
      );
    }

    await Promise.all(promises);
    return results;
  }

  /**
   * 获取所有已注册的 CLI 类型
   */
  getSupportedTypes(): readonly CliType[] {
    return Array.from(this.factories.keys());
  }

  /**
   * 检查指定 CLI 类型是否已注册
   */
  isRegistered(cliType: CliType): boolean {
    return this.factories.has(cliType);
  }

  /**
   * 获取所有适配器实例（创建所有未缓存的）
   */
  getAllAdapters(): readonly CliAdapter[] {
    return this.getSupportedTypes().map((type) => this.getAdapter(type));
  }

  /**
   * 注册所有内置适配器
   */
  private registerDefaultAdapters(): void {
    this.register(CliType.CodeX, () => new CodeXAdapter());
    this.register(CliType.ClaudeCode, () => new ClaudeCodeAdapter());
    this.register(CliType.OpenCode, () => new OpenCodeAdapter());
    this.register(CliType.Grok, () => new GenericTuiAdapter(CliType.Grok, "Grok CLI", "grok"));
    this.register(CliType.Copilot, () => new GenericTuiAdapter(CliType.Copilot, "Copilot CLI", "copilot"));
    this.register(CliType.Antigravity, () => new GenericTuiAdapter(CliType.Antigravity, "Antigravity CLI", "agy"));
    this.register(CliType.Kiro, () => new GenericTuiAdapter(CliType.Kiro, "Kiro CLI", "kiro-cli"));
    this.register(CliType.Cursor, () => new GenericTuiAdapter(CliType.Cursor, "Cursor CLI", "cursor-agent"));
    this.register(CliType.Droid, () => new GenericTuiAdapter(CliType.Droid, "Droid CLI", "droid"));
  }
}
