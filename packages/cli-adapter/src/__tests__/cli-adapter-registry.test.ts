/**
 * CLI 适配器注册表单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CliAdapterRegistry } from "../cli-adapter-registry.js";
import { CliType } from "../types.js";
import { CodeXAdapter } from "../codex-adapter.js";
import { ClaudeCodeAdapter } from "../claude-code-adapter.js";
import { OpenCodeAdapter } from "../opencode-adapter.js";

describe("CliAdapterRegistry", () => {
  let registry: CliAdapterRegistry;

  beforeEach(() => {
    CliAdapterRegistry.resetInstance();
    registry = CliAdapterRegistry.getInstance();
  });

  afterEach(() => {
    CliAdapterRegistry.resetInstance();
  });

  it("should be a singleton", () => {
    const instance1 = CliAdapterRegistry.getInstance();
    const instance2 = CliAdapterRegistry.getInstance();
    expect(instance1).toBe(instance2);
  });

  it("should register default adapters on construction", () => {
    const types = registry.getSupportedTypes();
    expect(types).toContain(CliType.CodeX);
    expect(types).toContain(CliType.ClaudeCode);
    expect(types).toContain(CliType.OpenCode);
    expect(types).toContain(CliType.Grok);
    expect(types).toContain(CliType.Copilot);
    expect(types).toContain(CliType.Antigravity);
    expect(types).toContain(CliType.Kiro);
    expect(types).toContain(CliType.Cursor);
    expect(types).toContain(CliType.Droid);
  });

  it("should create and cache adapter instances", () => {
    const adapter1 = registry.getAdapter(CliType.CodeX);
    const adapter2 = registry.getAdapter(CliType.CodeX);
    expect(adapter1).toBe(adapter2);
    expect(adapter1).toBeInstanceOf(CodeXAdapter);
  });

  it("should get ClaudeCode adapter", () => {
    const adapter = registry.getAdapter(CliType.ClaudeCode);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("should get OpenCode adapter", () => {
    const adapter = registry.getAdapter(CliType.OpenCode);
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
  });

  it("should throw for unknown CLI type", () => {
    expect(() => registry.getAdapter("unknown" as CliType)).toThrow();
  });

  it("should detect all and return results map", async () => {
    const results = await registry.detectAll();
    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(9);
    expect(results.has(CliType.CodeX)).toBe(true);
    expect(results.has(CliType.ClaudeCode)).toBe(true);
    expect(results.has(CliType.OpenCode)).toBe(true);
  });

  it("should reject duplicate registration", () => {
    expect(() =>
      registry.register(CliType.CodeX, () => new CodeXAdapter())
    ).toThrow();
  });

  it("should check if a type is registered", () => {
    expect(registry.isRegistered(CliType.CodeX)).toBe(true);
    expect(registry.isRegistered("unknown" as CliType)).toBe(false);
  });

  it("should get all adapters", () => {
    const adapters = registry.getAllAdapters();
    expect(adapters).toHaveLength(9);
  });
});
