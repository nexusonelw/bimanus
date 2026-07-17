import test from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { configureSettingsManagerForDesktopRuntime, withDesktopBundledRuntimeEnv } from "./runtime-deps.js";

test("desktop runtime env adds macOS GUI PATH fallbacks", () => {
  const inputEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
  };

  const env = withPlatform("darwin", () => withDesktopBundledRuntimeEnv(inputEnv));
  const entries = env.PATH?.split(delimiter) ?? [];

  assert.deepEqual(entries.slice(0, 6), [
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/sbin",
    "/sbin",
  ]);
  assert.ok(entries.includes("/Users/tester/.local/bin"));
  assert.ok(entries.includes("/Users/tester/.bun/bin"));
  assert.equal(inputEnv.PATH, "/usr/bin:/bin");
});

test("desktop runtime settings manager patches macOS process PATH for package installs", () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  process.env.PATH = "/usr/bin:/bin";
  process.env.HOME = "/Users/tester";

  try {
    const settingsManager = {} as Parameters<typeof configureSettingsManagerForDesktopRuntime>[0];
    withPlatform("darwin", () => configureSettingsManagerForDesktopRuntime(settingsManager));
    const entries = process.env.PATH?.split(delimiter) ?? [];

    assert.ok(entries.includes("/usr/local/bin"));
    assert.ok(entries.includes("/opt/homebrew/bin"));
    assert.ok(entries.includes("/Users/tester/.local/bin"));
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("desktop runtime resolves npm under lib/node_modules layout", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveDesktopBundledNodeRuntime } = await import("./runtime-deps.js");

  const resourcesRoot = mkdtempSync(join(tmpdir(), "pi-gui-node-runtime-"));
  const runtimeDir = join(resourcesRoot, "node-runtime");
  const npmCliPath = join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(runtimeDir, "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(runtimeDir, "node"), "");
  writeFileSync(npmCliPath, "");

  const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: resourcesRoot,
  });

  try {
    const runtime = withPlatform("darwin", () => resolveDesktopBundledNodeRuntime());
    assert.equal(runtime?.nodePath, join(runtimeDir, "node"));
    assert.equal(runtime?.npmCliPath, npmCliPath);
  } finally {
    if (originalResources) {
      Object.defineProperty(process, "resourcesPath", originalResources);
    } else {
      delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    }
    rmSync(resourcesRoot, { recursive: true, force: true });
  }
});

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}
