import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RuntimeSupervisorOptions } from "./runtime-supervisor.js";

const PI_GUI_NODE_PATH_ENV = "PI_GUI_NODE_PATH";
const PI_GUI_NPM_CLI_PATH_ENV = "PI_GUI_NPM_CLI_PATH";
const SETTINGS_MANAGER_DESKTOP_RUNTIME_PATCHED = "__piGuiDesktopRuntimePatched";

type DesktopRuntimeSettingsManager = SettingsManager & {
  getNpmCommand?: () => string[] | undefined;
  __piGuiDesktopRuntimePatched?: boolean;
};

export interface RuntimeDependencies {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
}

export interface DesktopBundledNodeRuntime {
  readonly nodePath: string;
  readonly npmCliPath?: string;
  readonly runtimeDir: string;
}

export function createRuntimeDependencies(options: RuntimeSupervisorOptions = {}): RuntimeDependencies {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  return {
    agentDir,
    authStorage,
    modelRegistry,
  };
}

export function createDesktopRuntimeSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return configureSettingsManagerForDesktopRuntime(SettingsManager.create(cwd, agentDir));
}

export function configureSettingsManagerForDesktopRuntime(settingsManager: SettingsManager): SettingsManager {
  applyDesktopMacPathFallbacksToProcessEnv();

  const runtime = resolveDesktopBundledNodeRuntime();
  if (!runtime?.npmCliPath) {
    return settingsManager;
  }

  const mutableSettingsManager = settingsManager as DesktopRuntimeSettingsManager;
  if (!mutableSettingsManager[SETTINGS_MANAGER_DESKTOP_RUNTIME_PATCHED]) {
    mutableSettingsManager.getNpmCommand = () => [runtime.nodePath, runtime.npmCliPath!];
    mutableSettingsManager[SETTINGS_MANAGER_DESKTOP_RUNTIME_PATCHED] = true;
  }
  prependProcessPathEntries([runtime.runtimeDir]);
  // npm needs NODE_PATH to find its own internal modules (e.g. npm-prefix.js).
  // The official npm.cmd wrapper sets this for the bundled npm installation.
  appendNodePathEntries(process.env, [npmNodeModulesPath(runtime.runtimeDir)]);
  return settingsManager;
}

export function resolveDesktopBundledNodeRuntime(): DesktopBundledNodeRuntime | undefined {
  // 先检查环境变量配置（跨平台）
  const configuredNodePath = process.env[PI_GUI_NODE_PATH_ENV]?.trim();
  const configuredNpmCliPath = process.env[PI_GUI_NPM_CLI_PATH_ENV]?.trim();
  if (configuredNodePath && existsSync(configuredNodePath)) {
    return {
      nodePath: configuredNodePath,
      ...(configuredNpmCliPath && existsSync(configuredNpmCliPath) ? { npmCliPath: configuredNpmCliPath } : {}),
      runtimeDir: dirname(configuredNodePath),
    };
  }

  if (process.platform !== "darwin") {
    return undefined;
  }

  // 检查 macOS 打包的 node runtime
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const runtimeDir = resourcesPath ? join(resourcesPath, "node-runtime") : undefined;
  if (!runtimeDir) return undefined;

  const nodePath = join(runtimeDir, "node");
  if (!existsSync(nodePath)) return undefined;

  const npmCliPath = resolveBundledNpmCliPath(runtimeDir);
  return { nodePath, ...(npmCliPath ? { npmCliPath } : {}), runtimeDir };
}

function resolveBundledNpmCliPath(runtimeDir: string): string | undefined {
  // Prefer lib/node_modules (official Node layout). Root node_modules is stripped
  // by electron-builder extraResources filtering and only exists in some source trees.
  const candidates = [
    join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function withDesktopBundledRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = resolveDesktopBundledNodeRuntime();
  if (!runtime) {
    return withDesktopMacPathFallbacks(env);
  }

  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    [PI_GUI_NODE_PATH_ENV]: runtime.nodePath,
    ...(runtime.npmCliPath ? { [PI_GUI_NPM_CLI_PATH_ENV]: runtime.npmCliPath } : {}),
  };
  prependEnvPathEntries(nextEnv, [runtime.runtimeDir]);
  // npm needs NODE_PATH to find its own internal modules (e.g. npm-prefix.js).
  appendNodePathEntries(nextEnv, [npmNodeModulesPath(runtime.runtimeDir)]);
  return withDesktopMacPathFallbacks(nextEnv);
}

function npmNodeModulesPath(runtimeDir: string): string {
  const preferred = join(runtimeDir, "lib", "node_modules", "npm", "node_modules");
  if (existsSync(preferred)) {
    return preferred;
  }
  return join(runtimeDir, "node_modules", "npm", "node_modules");
}

function appendNodePathEntries(env: NodeJS.ProcessEnv, entries: readonly string[]): void {
  const current = env.NODE_PATH ?? "";
  const nextEntries = uniquePathEntries([...current.split(delimiter).filter(Boolean), ...entries]);
  if (nextEntries.length > 0) {
    env.NODE_PATH = nextEntries.join(delimiter);
  }
}

function prependProcessPathEntries(entries: readonly string[]): void {
  prependEnvPathEntries(process.env, entries);
}

function applyDesktopMacPathFallbacksToProcessEnv(): void {
  if (process.platform !== "darwin") {
    return;
  }
  appendEnvPathEntries(process.env, macPathFallbackEntries(process.env));
}

function withDesktopMacPathFallbacks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") {
    return env;
  }

  const nextEnv = { ...env };
  appendEnvPathEntries(nextEnv, macPathFallbackEntries(nextEnv));
  return nextEnv;
}

function macPathFallbackEntries(env: NodeJS.ProcessEnv): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...(env.HOME ? [join(env.HOME, ".local", "bin"), join(env.HOME, ".bun", "bin")] : []),
  ];
}

function appendEnvPathEntries(env: NodeJS.ProcessEnv, entries: readonly string[]): void {
  const pathKey = resolvePathEnvKey(env);
  const current = env[pathKey] ?? "";
  const nextEntries = uniquePathEntries([...current.split(delimiter), ...entries.filter(Boolean)]);
  const nextPath = nextEntries.join(delimiter);
  env[pathKey] = nextPath;
}

function prependEnvPathEntries(env: NodeJS.ProcessEnv, entries: readonly string[]): void {
  const pathKey = resolvePathEnvKey(env);
  const current = env[pathKey] ?? "";
  const nextEntries = uniquePathEntries([...entries.filter(Boolean), ...current.split(delimiter)]);
  const nextPath = nextEntries.join(delimiter);
  env[pathKey] = nextPath;
  if (process.platform === "win32") {
    env.PATH = nextPath;
    env.Path = nextPath;
  }
}

function resolvePathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function uniquePathEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueEntries: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueEntries.push(trimmed);
  }
  return uniqueEntries;
}
