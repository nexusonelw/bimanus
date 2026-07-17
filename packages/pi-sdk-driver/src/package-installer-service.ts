import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
  DefaultPackageManager,
  PackageSource,
  PathMetadata,
  ResolvedPaths,
  ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimePackageFilters,
  RuntimePackageRecord,
  RuntimePackageSearchRecord,
} from "@bimanus/session-driver/runtime-types";
import { resolveDesktopBundledNodeRuntime, withDesktopBundledRuntimeEnv } from "./runtime-deps.js";

type PackageResourceType = "extensions" | "skills" | "prompts" | "themes";
type ToggleablePackageResourceKind = "extension" | "skill";

interface PackageListingState {
  readonly enabled: boolean;
}

interface PackageServiceContext {
  readonly packageManager: DefaultPackageManager;
  readonly settingsManager: SettingsManager;
}

interface NpmSearchResponse {
  readonly objects?: readonly NpmSearchObject[];
}

interface NpmSearchObject {
  readonly package?: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
    readonly keywords?: readonly string[];
    readonly links?: {
      readonly npm?: string;
      readonly homepage?: string;
      readonly repository?: string;
    };
  };
}

export class PackageInstallerService {
  async listPackages(
    context: PackageServiceContext,
    resolvedPaths: ResolvedPaths,
  ): Promise<readonly RuntimePackageRecord[]> {
    const globalSettings = context.settingsManager.getGlobalSettings();
    const projectSettings = context.settingsManager.getProjectSettings();
    const runtimeStateByIdentity = collectPackageListingState(resolvedPaths);
    const packageEntries = [
      ...(globalSettings.packages ?? []).map((entry) => toScopedPackageEntry(context, entry, "user")),
      ...(projectSettings.packages ?? []).map((entry) => toScopedPackageEntry(context, entry, "project")),
    ];
    const entriesByIdentity = new Map<
      string,
      {
        user?: ScopedPackageEntry;
        project?: ScopedPackageEntry;
      }
    >();

    for (const entry of packageEntries) {
      const identity = packageEntryIdentity(entry.rawSource, entry.installedPath);
      const current = entriesByIdentity.get(identity) ?? {};
      current[entry.scope] = entry;
      entriesByIdentity.set(identity, current);
    }

    return [...entriesByIdentity.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([, groupedEntries]) => {
        const globalEntry = groupedEntries.user;
        const projectEntry = groupedEntries.project;
        const effectiveEntry = projectEntry ?? globalEntry;
        if (!effectiveEntry) {
          throw new Error("Expected a package entry while building runtime package records.");
        }

        const installedPath = globalEntry?.installedPath ?? projectEntry?.installedPath;
        const runtimeSource = toRuntimePackageSource(effectiveEntry.rawSource, installedPath);
        const filters = toRuntimePackageFilters(effectiveEntry.entry);
        const runtimeState = runtimeStateByIdentity.get(packageEntryIdentity(runtimeSource, installedPath));

        return {
          source: runtimeSource,
          sourceType: inferPackageSourceType(runtimeSource),
          installScope: globalEntry ? "user" : "project",
          ...(installedPath ? { installedPath } : {}),
          projectOverride: projectEntry !== undefined,
          enabled: runtimeState?.enabled ?? false,
          ...(filters ? { filters } : {}),
        } satisfies RuntimePackageRecord;
      });
  }

  async installPackage(context: PackageServiceContext, source: string): Promise<void> {
    await context.packageManager.installAndPersist(source);
    await rebuildPackageForElectronHost(context, source);
    await context.settingsManager.flush();
  }

  async updatePackage(
    context: PackageServiceContext,
    source: string,
    installScope?: RuntimePackageRecord["installScope"],
  ): Promise<void> {
    if (inferPackageSourceType(source) === "local") {
      throw new Error("Local path packages cannot be updated automatically. Update the source folder directly.");
    }

    const updateSource = toFloatingUpdateSource(source);
    if (updateSource === source) {
      await context.packageManager.update(source);
    } else {
      const configuredScopes = getConfiguredPackageScopes(context, source);
      const targetScopes = configuredScopes.length > 0 ? configuredScopes : [installScope ?? "user"];
      for (const scope of targetScopes) {
        await context.packageManager.installAndPersist(updateSource, scope === "project" ? { local: true } : undefined);
      }
    }

    await rebuildPackageForElectronHost(context, updateSource);
    await context.settingsManager.flush();
  }

  async repairPackageForCurrentHost(context: PackageServiceContext, source: string): Promise<boolean> {
    return rebuildPackageForElectronHost(context, source);
  }

  async repairPackageForBundledNodeRuntime(context: PackageServiceContext, source: string): Promise<boolean> {
    return rebuildPackageForBundledNodeRuntime(context, source);
  }

  async removePackage(context: PackageServiceContext, source: string): Promise<void> {
    await context.packageManager.remove(source);

    const removedGlobal = context.packageManager.removeSourceFromSettings(source);
    const projectSource = normalizeProjectOverrideSource(context, source);
    const removedProject = context.packageManager.removeSourceFromSettings(projectSource, { local: true });
    if (removedGlobal || removedProject) {
      await context.settingsManager.flush();
    }
  }

  async setPackageEnabled(context: PackageServiceContext, source: string, enabled: boolean): Promise<void> {
    const projectSource = normalizeProjectOverrideSource(context, source);
    if (enabled) {
      const removed = context.packageManager.removeSourceFromSettings(projectSource, { local: true });
      if (removed) {
        await context.settingsManager.flush();
      }
      return;
    }

    const packages = [...(context.settingsManager.getProjectSettings().packages ?? [])];
    const packageIndex = packages.findIndex((entry) => packageSourcesMatch(context, packageSourceString(entry), projectSource));
    const nextPackage: PackageSource = {
      source: projectSource,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };

    if (packageIndex >= 0) {
      packages[packageIndex] = nextPackage;
    } else {
      packages.push(nextPackage);
    }

    context.settingsManager.setProjectPackages(packages);
    await context.settingsManager.flush();
  }

  async setPackageResourceEnabled(
    context: PackageServiceContext,
    resource: ResolvedResource,
    kind: ToggleablePackageResourceKind,
    enabled: boolean,
  ): Promise<void> {
    const source = normalizeProjectOverrideSource(context, resource.metadata.source);
    const packages = [...(context.settingsManager.getProjectSettings().packages ?? [])];
    const packageIndex = packages.findIndex((entry) => packageSourcesMatch(context, packageSourceString(entry), source));

    if (enabled && packageIndex < 0) {
      return;
    }

    const currentPackage = packageIndex >= 0 ? normalizePackageSource(packages[packageIndex]!) : { source };
    const packageKey = kind === "extension" ? "extensions" : "skills";
    const currentPatterns = [...(currentPackage[packageKey] ?? [])];
    const nextPatterns = replaceResourcePattern(
      currentPatterns,
      relativePackageResourcePattern(resource.path, resource.metadata),
      enabled,
    );

    if (nextPatterns.length > 0) {
      currentPackage[packageKey] = nextPatterns;
    } else {
      delete currentPackage[packageKey];
    }

    const nextEntry = hasPackageFilters(currentPackage) ? currentPackage : currentPackage.source;
    if (packageIndex >= 0) {
      packages[packageIndex] = nextEntry;
    } else {
      packages.push(nextEntry);
    }

    context.settingsManager.setProjectPackages(packages);
    await context.settingsManager.flush();
  }

  async searchPackages(query: string, limit = 20): Promise<readonly RuntimePackageSearchRecord[]> {
    const searchUrl = new URL("https://registry.npmjs.org/-/v1/search");
    const trimmedQuery = query.trim();
    searchUrl.searchParams.set("text", trimmedQuery ? `keywords:pi-package ${trimmedQuery}` : "keywords:pi-package");
    searchUrl.searchParams.set("size", String(limit));
    searchUrl.searchParams.set("from", "0");

    const response = await fetch(searchUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`Failed to search pi packages: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as NpmSearchResponse;
    return (payload.objects ?? [])
      .flatMap((entry) => {
        const pkg = entry.package;
        const name = typeof pkg?.name === "string" ? pkg.name.trim() : "";
        const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
        if (!name || !version) {
          return [];
        }

        const keywords =
          Array.isArray(pkg?.keywords) ? pkg.keywords.filter((value): value is string => typeof value === "string") : [];
        if (!keywords.includes("pi-package")) {
          return [];
        }

        const description =
          typeof pkg?.description === "string" && pkg.description.trim() ? pkg.description.trim() : undefined;
        const npmUrl = typeof pkg?.links?.npm === "string" && pkg.links.npm.trim() ? pkg.links.npm.trim() : undefined;
        const homepageUrl =
          typeof pkg?.links?.homepage === "string" && pkg.links.homepage.trim() ? pkg.links.homepage.trim() : undefined;
        const repositoryUrl =
          typeof pkg?.links?.repository === "string" && pkg.links.repository.trim()
            ? pkg.links.repository.trim()
            : undefined;

        return [
          {
            name,
            source: `npm:${name}@${version}`,
            version,
            ...(description ? { description } : {}),
            keywords,
            ...(npmUrl ? { npmUrl } : {}),
            ...(homepageUrl ? { homepageUrl } : {}),
            ...(repositoryUrl ? { repositoryUrl } : {}),
          } satisfies RuntimePackageSearchRecord,
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

function collectPackageListingState(resolvedPaths: ResolvedPaths): Map<string, PackageListingState> {
  const stateByIdentity = new Map<string, PackageListingState>();

  for (const resource of [
    ...resolvedPaths.extensions,
    ...resolvedPaths.skills,
    ...resolvedPaths.prompts,
    ...resolvedPaths.themes,
  ]) {
    if (resource.metadata.origin !== "package") {
      continue;
    }

    const identity = packageEntryIdentity(resource.metadata.source, resource.metadata.baseDir);
    const currentState = stateByIdentity.get(identity);
    stateByIdentity.set(identity, {
      enabled: currentState?.enabled === true || resource.enabled,
    });
  }

  return stateByIdentity;
}

interface ScopedPackageEntry {
  readonly scope: "user" | "project";
  readonly entry: PackageSource;
  readonly rawSource: string;
  readonly installedPath?: string;
}

function toScopedPackageEntry(
  context: PackageServiceContext,
  entry: PackageSource,
  scope: ScopedPackageEntry["scope"],
): ScopedPackageEntry {
  const rawSource = packageSourceString(entry);
  const installedPath = context.packageManager.getInstalledPath(rawSource, scope);
  return {
    scope,
    entry,
    rawSource,
    ...(installedPath ? { installedPath } : {}),
  };
}

function packageSourceString(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageEntryIdentity(source: string, installedPath?: string): string {
  if (inferPackageSourceType(source) === "local") {
    return `local:${installedPath ? resolve(installedPath) : source}`;
  }

  return source;
}

function toRuntimePackageSource(source: string, installedPath?: string): string {
  if (inferPackageSourceType(source) === "local" && installedPath) {
    return installedPath;
  }

  return source;
}

function normalizePackageSource(entry: PackageSource): {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
} {
  return typeof entry === "string" ? { source: entry } : { ...entry };
}

function hasPackageFilters(entry: {
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
  readonly prompts?: readonly string[];
  readonly themes?: readonly string[];
}): boolean {
  return ["extensions", "skills", "prompts", "themes"].some((key) =>
    Object.prototype.hasOwnProperty.call(entry, key),
  );
}

function toRuntimePackageFilters(entry: PackageSource): RuntimePackageFilters | undefined {
  if (typeof entry === "string") {
    return undefined;
  }

  return {
    ...(entry.extensions ? { extensions: [...entry.extensions] } : {}),
    ...(entry.skills ? { skills: [...entry.skills] } : {}),
    ...(entry.prompts ? { prompts: [...entry.prompts] } : {}),
    ...(entry.themes ? { themes: [...entry.themes] } : {}),
  };
}

function inferPackageSourceType(source: string): RuntimePackageRecord["sourceType"] {
  if (source.startsWith("npm:")) {
    return "npm";
  }

  if (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~/") ||
    source === "~"
  ) {
    return "local";
  }

  return "git";
}

function toFloatingUpdateSource(source: string): string {
  if (source.startsWith("npm:")) {
    const parsed = parseNpmSource(source);
    if (parsed?.version && isExactNpmVersion(parsed.version)) {
      return `npm:${parsed.name}`;
    }
    return source;
  }

  return stripGitRef(source) ?? source;
}

function parseNpmSource(source: string): { readonly name: string; readonly version?: string } | undefined {
  const spec = source.startsWith("npm:") ? source.slice("npm:".length).trim() : source.trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match?.[1]) {
    return undefined;
  }

  return {
    name: match[1],
    ...(match[2] ? { version: match[2] } : {}),
  };
}

function isExactNpmVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function stripGitRef(source: string): string | undefined {
  const refSeparatorIndex = source.lastIndexOf("@");
  if (refSeparatorIndex < 0) {
    return undefined;
  }

  const pathSeparatorIndex = Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"));
  if (refSeparatorIndex <= pathSeparatorIndex) {
    return undefined;
  }

  return source.slice(0, refSeparatorIndex);
}

function getConfiguredPackageScopes(
  context: PackageServiceContext,
  source: string,
): RuntimePackageRecord["installScope"][] {
  const scopes: RuntimePackageRecord["installScope"][] = [];
  if (
    (context.settingsManager.getGlobalSettings().packages ?? []).some((entry) =>
      packagesShareUpdateIdentity(packageSourceString(entry), source),
    )
  ) {
    scopes.push("user");
  }
  if (
    (context.settingsManager.getProjectSettings().packages ?? []).some((entry) =>
      packagesShareUpdateIdentity(packageSourceString(entry), source),
    )
  ) {
    scopes.push("project");
  }

  return scopes;
}

function packagesShareUpdateIdentity(left: string, right: string): boolean {
  const leftType = inferPackageSourceType(left);
  const rightType = inferPackageSourceType(right);
  if (leftType !== rightType) {
    return false;
  }
  if (leftType === "npm") {
    const leftName = parseNpmSource(left)?.name;
    const rightName = parseNpmSource(right)?.name;
    return Boolean(leftName && rightName && leftName === rightName);
  }
  if (leftType === "git") {
    return (stripGitRef(left) ?? left) === (stripGitRef(right) ?? right);
  }

  return left === right;
}

function normalizeProjectOverrideSource(context: PackageServiceContext, source: string): string {
  if (inferPackageSourceType(source) !== "local") {
    return source;
  }

  const installedPath =
    context.packageManager.getInstalledPath(source, "user") ??
    context.packageManager.getInstalledPath(source, "project");
  return installedPath ?? source;
}

function packageSourcesMatch(context: PackageServiceContext, left: string, right: string): boolean {
  if (inferPackageSourceType(left) !== "local" && inferPackageSourceType(right) !== "local") {
    return left === right;
  }

  return resolveProjectScopedSource(context, left) === resolveProjectScopedSource(context, right);
}

function resolveProjectScopedSource(context: PackageServiceContext, source: string): string {
  if (inferPackageSourceType(source) !== "local") {
    return source;
  }

  const installedPath =
    context.packageManager.getInstalledPath(source, "project") ??
    context.packageManager.getInstalledPath(source, "user");
  if (installedPath) {
    return installedPath;
  }

  return resolve(projectPackageBaseDir(context.packageManager), source);
}

function projectPackageBaseDir(packageManager: DefaultPackageManager): string {
  return join((packageManager as unknown as { cwd: string }).cwd, ".pi");
}

function relativePackageResourcePattern(filePath: string, metadata: PathMetadata): string {
  const baseDir = metadata.baseDir ?? dirname(filePath);
  return relative(baseDir, filePath);
}

function replaceResourcePattern(patterns: readonly string[], resourcePattern: string, enabled: boolean): string[] {
  const nextPatterns = patterns.filter((pattern) => stripPrefix(pattern) !== resourcePattern);
  nextPatterns.push(`${enabled ? "+" : "-"}${resourcePattern}`);
  return nextPatterns;
}

function stripPrefix(pattern: string): string {
  return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

async function rebuildPackageForElectronHost(context: PackageServiceContext, source: string): Promise<boolean> {
  const electronVersion = process.versions.electron;
  if (!electronVersion) {
    return false;
  }

  const sourceType = inferPackageSourceType(source);
  if (sourceType === "local") {
    return false;
  }

  const installedPaths = getInstalledPackagePaths(context, source);
  if (installedPaths.length === 0) {
    return false;
  }

  for (const installedPath of installedPaths) {
    await rebuildPackageWithNpmCommand(context, installedPath, electronNativeModuleEnv(electronVersion));
  }
  return true;
}

function getInstalledPackagePaths(context: PackageServiceContext, source: string): string[] {
  return [context.packageManager.getInstalledPath(source, "user"), context.packageManager.getInstalledPath(source, "project")]
    .filter((installedPath): installedPath is string => Boolean(installedPath))
    .filter((installedPath, index, installedPaths) => installedPaths.indexOf(installedPath) === index);
}

async function rebuildPackageForBundledNodeRuntime(context: PackageServiceContext, source: string): Promise<boolean> {
  const runtime = resolveDesktopBundledNodeRuntime();
  if (!runtime) {
    return false;
  }

  const sourceType = inferPackageSourceType(source);
  if (sourceType === "local") {
    return false;
  }

  const installedPaths = getInstalledPackagePaths(context, source);
  if (installedPaths.length === 0) {
    return false;
  }

  for (const installedPath of installedPaths) {
    await rebuildPackageWithNpmCommand(context, installedPath, withDesktopBundledRuntimeEnv(process.env));
  }
  return true;
}

async function rebuildPackageWithNpmCommand(
  context: PackageServiceContext,
  installedPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const [npmCommand, ...npmArgs] = resolveNpmCommand(context);
  if (!npmCommand) {
    throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
  }

  await runCommand(npmCommand, [...npmArgs, "rebuild"], installedPath, env);
}

function resolveNpmCommand(context: PackageServiceContext): string[] {
  const configured = context.settingsManager.getNpmCommand();
  if (configured && configured.length > 0 && configured[0]) {
    return [...configured];
  }

  // Avoid bare `npm` under Electron GUI PATH: prefer the bundled Node + npm-cli.
  const runtime = resolveDesktopBundledNodeRuntime();
  if (runtime?.npmCliPath) {
    return [runtime.nodePath, runtime.npmCliPath];
  }

  return ["npm"];
}

function electronNativeModuleEnv(electronVersion: string): NodeJS.ProcessEnv {
  const electronGypHome = join(homedir(), ".electron-gyp");
  return withDesktopBundledRuntimeEnv({
    ...process.env,
    npm_config_target: electronVersion,
    npm_config_arch: process.arch,
    npm_config_target_arch: process.arch,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_runtime: "electron",
    npm_config_devdir: electronGypHome,
    HOME: process.platform === "win32" ? process.env.HOME : electronGypHome,
  });
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      rejectPromise(new Error(`Failed to rebuild native modules for Electron in ${cwd}.${suffix}`));
    });
  });
}
