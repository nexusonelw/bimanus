import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  type PackageSource,
  SettingsManager,
  parseFrontmatter,
  stripFrontmatter,
  type ExtensionFactory,
  type PathMetadata,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeLoginCallbacks,
  RuntimeExtensionDiagnostic,
  RuntimeExtensionRecord,
  RuntimeModelRecord,
  RuntimePackageRecord,
  RuntimePackageSearchRecord,
  RuntimeProviderRecord,
  RuntimeResourceDriver,
  RuntimeSettingsSnapshot,
  RuntimeSkillRecord,
  RuntimeSourceInfo,
  RuntimeSnapshot,
} from "@bimanus/session-driver/runtime-types";
import type { WorkspaceRef } from "@bimanus/session-driver";
import { configureSettingsManagerForDesktopRuntime, createRuntimeDependencies } from "./runtime-deps.js";
import { createSettingsManagerWithoutNpmPackages, isGlobalNpmLookupError } from "./npm-package-fallback.js";
import { skillSlashCommand } from "./runtime-command-utils.js";
import type { AuthStatus, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { PackageInstallerService } from "./package-installer-service.js";

interface ModelSettingsSnapshot {
  readonly defaultProvider?: string;
  readonly defaultModelId?: string;
  readonly defaultThinkingLevel?: RuntimeSettingsSnapshot["defaultThinkingLevel"];
  readonly enabledModelPatterns: readonly string[];
}

interface RuntimeContext {
  readonly workspace: WorkspaceRef;
  readonly settingsManager: SettingsManager;
  readonly packageManager: DefaultPackageManager;
  readonly resourceLoader: DefaultResourceLoader;
}

interface ProjectWritableSettingsManager {
  markProjectModified(field: string, nestedKey?: string): void;
  saveProjectSettings(settings: Record<string, unknown>): void;
}

export interface RuntimeInlineExtensionMetadata {
  readonly displayName: string;
  readonly description?: string;
}

export interface RuntimeSupervisorOptions {
  readonly agentDir?: string;
  readonly authStorage?: AuthStorage;
  readonly modelRegistry?: ModelRegistry;
  readonly extensionFactories?: readonly ExtensionFactory[];
  readonly inlineExtensionMetadata?: readonly RuntimeInlineExtensionMetadata[];
}

type ResourceScope = "user" | "project";
type ToggleableResourceKind = "extension" | "skill";

interface PackageMetadata {
  readonly displayName?: string;
  readonly description?: string;
}

export class RuntimeSupervisor implements RuntimeResourceDriver {
  private readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly extensionFactories: readonly ExtensionFactory[];
  private readonly inlineExtensionMetadata: readonly RuntimeInlineExtensionMetadata[];
  private readonly packageInstaller = new PackageInstallerService();
  private readonly contexts = new Map<string, RuntimeContext>();

  constructor(options: RuntimeSupervisorOptions = {}) {
    const deps = createRuntimeDependencies(options);
    this.agentDir = deps.agentDir;
    this.authStorage = deps.authStorage;
    this.modelRegistry = deps.modelRegistry;
    this.extensionFactories = options.extensionFactories ?? [];
    this.inlineExtensionMetadata = options.inlineExtensionMetadata ?? [];
  }

  async getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    return this.buildSnapshot(context);
  }

  async refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.reload();
    this.authStorage.reload();
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    await this.repairBrokenNativePackages(context);
    await this.reconcileEnabledModelPatterns(context);
    return this.buildSnapshot(context);
  }

  async prepareRuntimeForExternalLaunch(workspace: WorkspaceRef): Promise<void> {
    // Windows TUI launches an external pi process that will load extensions again
    // in its own runtime. Preloading them here duplicates that work and can block
    // session creation on large plugin sets.
    if (process.platform === "win32") {
      return;
    }
    await this.refreshRuntime(workspace);
  }

  async login(workspace: WorkspaceRef, providerId: string, callbacks: RuntimeLoginCallbacks): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.authStorage.login(providerId, callbacks);
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    await this.reconcileEnabledModelPatterns(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async logout(workspace: WorkspaceRef, providerId: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    this.authStorage.logout(providerId);
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    await this.reconcileEnabledModelPatterns(context);
    return this.buildSnapshot(context);
  }

  async setProviderApiKey(workspace: WorkspaceRef, providerId: string, apiKey: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new Error("API key is required.");
    }
    if (!providerSupportsDesktopApiKeySetup(providerId)) {
      throw new Error(`API key setup is not supported for ${providerId}.`);
    }
    this.authStorage.set(providerId, { type: "api_key", key: normalized });
    this.modelRegistry.refresh();
    await context.resourceLoader.reload();
    await this.reconcileEnabledModelPatterns(context, [providerId]);
    return this.buildSnapshot(context);
  }

  async setDefaultModel(
    workspace: WorkspaceRef,
    selection: {
      readonly provider: string;
      readonly modelId: string;
    },
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setDefaultModelAndProvider(selection.provider, selection.modelId);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setDefaultThinkingLevel(
    workspace: WorkspaceRef,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    if (!thinkingLevel) {
      throw new Error("Thinking level is required.");
    }
    context.settingsManager.setDefaultThinkingLevel(thinkingLevel);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async setEnableSkillCommands(workspace: WorkspaceRef, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnableSkillCommands(enabled);
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setScopedModelPatterns(workspace: WorkspaceRef, patterns: readonly string[]): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    context.settingsManager.setEnabledModels(patterns.length > 0 ? [...patterns] : undefined);
    await context.settingsManager.flush();
    return this.buildSnapshot(context);
  }

  async getGlobalModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot> {
    const context = await this.ensureContext(workspace);
    return toModelSettingsSnapshot(context.settingsManager.getGlobalSettings() as Record<string, unknown>);
  }

  async setSkillEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.skills.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown skill: ${filePath}`);
    }

    if (resource.metadata.scope === "user" && resource.metadata.origin === "package") {
      await this.packageInstaller.setPackageResourceEnabled(context, resource, "skill", enabled);
      await context.resourceLoader.reload();
      return this.buildSnapshot(context);
    }

    this.toggleResource(context, resource, enabled, "skill");
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async removeSkill(workspace: WorkspaceRef, filePath: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.skills.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown skill: ${filePath}`);
    }
    if (resource.metadata.origin !== "top-level") {
      throw new Error(`Cannot remove packaged skill: ${filePath}`);
    }

    this.toggleResource(context, resource, false, "skill");
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setExtensionEnabled(workspace: WorkspaceRef, filePath: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.extensions.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown extension: ${filePath}`);
    }

    if (resource.metadata.scope === "user" && resource.metadata.origin === "package") {
      await this.packageInstaller.setPackageResourceEnabled(context, resource, "extension", enabled);
      await context.resourceLoader.reload();
      return this.buildSnapshot(context);
    }

    this.toggleResource(context, resource, enabled, "extension");
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async removeExtension(workspace: WorkspaceRef, filePath: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const resource = resolvedPaths.extensions.find((entry) => resolve(entry.path) === resolve(filePath));
    if (!resource) {
      throw new Error(`Unknown extension: ${filePath}`);
    }
    if (resource.metadata.origin !== "top-level") {
      throw new Error(`Cannot remove packaged extension: ${filePath}`);
    }
    if (resource.metadata.scope !== "user" && resource.metadata.scope !== "project") {
      throw new Error(`Cannot remove extension at scope ${resource.metadata.scope}`);
    }

    const pattern = this.relativeResourcePattern(
      resource.path,
      resource.metadata,
      resource.metadata.scope,
      resource.metadata.origin,
    );
    const settings =
      resource.metadata.scope === "project" ? context.settingsManager.getProjectSettings() : context.settingsManager.getGlobalSettings();
    const nextPaths = removeResourcePattern(
      resource.metadata.scope === "project" ? settings.extensions ?? [] : settings.extensions ?? [],
      pattern,
    );

    this.setTopLevelResourcePaths(context.settingsManager, resource.metadata.scope, "extension", nextPaths);
    await context.settingsManager.flush();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async installPackage(workspace: WorkspaceRef, source: string): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.packageInstaller.installPackage(context, source);
    await context.settingsManager.reload();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async updatePackage(
    workspace: WorkspaceRef,
    source: string,
    installScope?: RuntimePackageRecord["installScope"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.packageInstaller.updatePackage(context, source, installScope);
    await context.settingsManager.reload();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async removePackage(
    workspace: WorkspaceRef,
    source: string,
    _installScope?: RuntimePackageRecord["installScope"],
  ): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.packageInstaller.removePackage(context, source);
    await context.settingsManager.reload();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async setPackageEnabled(workspace: WorkspaceRef, source: string, enabled: boolean): Promise<RuntimeSnapshot> {
    const context = await this.ensureContext(workspace);
    await this.packageInstaller.setPackageEnabled(context, source, enabled);
    await context.settingsManager.reload();
    await context.resourceLoader.reload();
    return this.buildSnapshot(context);
  }

  async searchPackages(query: string): Promise<readonly RuntimePackageSearchRecord[]> {
    return this.packageInstaller.searchPackages(query);
  }

  private async ensureContext(workspace: WorkspaceRef): Promise<RuntimeContext> {
    const existing = this.contexts.get(workspace.workspaceId);
    if (existing) {
      return existing;
    }

    let settingsManager = configureSettingsManagerForDesktopRuntime(SettingsManager.create(workspace.path, this.agentDir));
    let packageManager = new DefaultPackageManager({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
    });
    let resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [...this.extensionFactories],
    });
    try {
      await resourceLoader.reload();
      await this.repairBrokenNativePackages({
        workspace,
        settingsManager,
        packageManager,
        resourceLoader,
      });
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime resource loading without npm package sources for ${workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      settingsManager = configureSettingsManagerForDesktopRuntime(fallbackSettingsManager);
      packageManager = new DefaultPackageManager({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
      });
      resourceLoader = new DefaultResourceLoader({
        cwd: workspace.path,
        agentDir: this.agentDir,
        settingsManager,
        extensionFactories: [...this.extensionFactories],
      });
      await resourceLoader.reload();
      await this.repairBrokenNativePackages({
        workspace,
        settingsManager,
        packageManager,
        resourceLoader,
      });
    }

    const context: RuntimeContext = {
      workspace,
      settingsManager,
      packageManager,
      resourceLoader,
    };
    this.contexts.set(workspace.workspaceId, context);
    return context;
  }

  private async buildSnapshot(context: RuntimeContext): Promise<RuntimeSnapshot> {
    const resolvedPaths = await this.resolveRuntimePaths(context);
    const [skills, extensions, providers, models, packages] = await Promise.all([
      this.buildSkillRecords(context, resolvedPaths.skills),
      this.buildExtensionRecords(context, resolvedPaths.extensions),
      this.buildProviderRecords(),
      this.buildModelRecords(),
      this.buildPackageRecords(context, resolvedPaths),
    ]);

    const defaultProvider = context.settingsManager.getDefaultProvider();
    const defaultModelId = context.settingsManager.getDefaultModel();
    const defaultThinkingLevel = context.settingsManager.getDefaultThinkingLevel();
    const settings: RuntimeSettingsSnapshot = {
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      enableSkillCommands: context.settingsManager.getEnableSkillCommands(),
      enabledModelPatterns: context.settingsManager.getEnabledModels() ?? [],
    };

    return {
      workspace: context.workspace,
      providers,
      models,
      skills,
      extensions,
      packages,
      settings,
    };
  }

  private async resolveRuntimePaths(context: RuntimeContext): Promise<ResolvedPaths> {
    try {
      return await context.packageManager.resolve();
    } catch (error) {
      if (!isGlobalNpmLookupError(error)) {
        throw error;
      }

      const fallbackSettingsManager = createSettingsManagerWithoutNpmPackages(context.settingsManager);
      if (!fallbackSettingsManager) {
        throw error;
      }

      console.warn(
        `[pi-gui] Falling back to runtime package resolution without npm package sources for ${context.workspace.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const fallbackPackageManager = new DefaultPackageManager({
        cwd: context.workspace.path,
        agentDir: this.agentDir,
        settingsManager: fallbackSettingsManager,
      });
      return fallbackPackageManager.resolve();
    }
  }

  private async buildProviderRecords(): Promise<readonly RuntimeProviderRecord[]> {
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
    const providerIds = new Set<string>([
      ...this.modelRegistry.getAll().map((model) => model.provider),
      ...oauthProviders.keys(),
      ...this.authStorage.list(),
    ]);

    return [...providerIds]
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => {
        const auth = this.authStorage.get(providerId);
        const oauthProvider = oauthProviders.get(providerId);
        const apiKeySetupSupported = providerSupportsDesktopApiKeySetup(providerId);
        const providerAuthStatus = this.modelRegistry.getProviderAuthStatus(providerId);
        const hasAuth = providerAuthStatus.configured || this.authStorage.hasAuth(providerId);
        return {
          id: providerId,
          name: oauthProvider?.name ?? providerId,
          hasAuth,
          authType: auth?.type ?? "none",
          authSource: inferProviderAuthSource(auth, providerAuthStatus, apiKeySetupSupported),
          oauthSupported: Boolean(oauthProvider),
          apiKeySetupSupported,
        };
      });
  }

  private async buildModelRecords(): Promise<readonly RuntimeModelRecord[]> {
    this.modelRegistry.refresh();
    const availableKeys = new Set(
      (await this.modelRegistry.getAvailable()).map((model) => `${model.provider}:${model.id}`),
    );
    const providers = new Map((await this.buildProviderRecords()).map((provider) => [provider.id, provider]));

    return this.modelRegistry
      .getAll()
      .map<RuntimeModelRecord>((model) => {
        const provider = providers.get(model.provider);
        return {
          providerId: model.provider,
          providerName: provider?.name ?? model.provider,
          modelId: model.id,
          label: model.name,
          available: availableKeys.has(`${model.provider}:${model.id}`),
          authType: provider?.authType ?? "none",
          reasoning: Boolean(model.reasoning),
          supportsImages: model.input.includes("image"),
        };
      })
      .sort((left, right) =>
        left.providerId === right.providerId
          ? left.modelId.localeCompare(right.modelId)
          : left.providerId.localeCompare(right.providerId),
      );
  }

  private async reconcileEnabledModelPatterns(
    context: RuntimeContext,
    providerIds?: readonly string[],
  ): Promise<void> {
    const storedPatterns = context.settingsManager.getEnabledModels() ?? [];
    if (storedPatterns.length === 0) {
      return;
    }

    const providers = await this.buildProviderRecords();
    const models = await this.buildModelRecords();
    const currentPatterns = pruneStaleExactModelPatterns(storedPatterns, models, providers);
    const availableModelIds = new Set(
      models
        .filter((model) => model.available)
        .map((model) => `${model.providerId}/${model.modelId}`.toLowerCase()),
    );
    const hasSelectableModels = currentPatterns.some((pattern) =>
      patternReferencesAvailableModel(pattern, availableModelIds),
    );
    const candidateProviderIds =
      providerIds && providerIds.length > 0
        ? providerIds
        : hasSelectableModels
          ? []
          : providers
              .filter((provider) => provider.hasAuth)
              .map((provider) => provider.id);
    if (candidateProviderIds.length === 0) {
      if (currentPatterns.length !== storedPatterns.length) {
        setEnabledModelPatternsForActiveScope(context.settingsManager, currentPatterns);
        await context.settingsManager.flush();
      }
      return;
    }

    const candidateProviderSet = new Set(candidateProviderIds);
    const nextPatterns = mergeEnabledModelPatterns(
      currentPatterns,
      models
        .filter((model) => model.available && candidateProviderSet.has(model.providerId))
        .map((model) => `${model.providerId}/${model.modelId}`),
    );
    if (modelPatternsAreEqual(nextPatterns, storedPatterns)) {
      return;
    }

    setEnabledModelPatternsForActiveScope(context.settingsManager, nextPatterns);
    await context.settingsManager.flush();
  }

  private async buildSkillRecords(
    context: RuntimeContext,
    resolvedSkills: readonly ResolvedResource[],
  ): Promise<readonly RuntimeSkillRecord[]> {
    const loadedSkills = new Map(
      context.resourceLoader
        .getSkills()
        .skills.map((skill) => [resolve(skill.filePath), skill] as const),
    );

    const records = await Promise.all(
      resolvedSkills.map(async (resource) => {
        const filePath = resolve(resource.path);
        const loaded = loadedSkills.get(filePath);
        const fallback = loaded ? undefined : await readSkillMetadata(filePath);
        const name = loaded?.name ?? fallback?.name ?? inferSkillName(filePath);
        const description = loaded?.description ?? fallback?.description ?? "No description provided.";
        const disableModelInvocation = loaded?.disableModelInvocation ?? fallback?.disableModelInvocation ?? false;

        return {
          name,
          description,
          filePath,
          baseDir: loaded?.baseDir ?? dirname(filePath),
          source: resource.metadata.source,
          sourceInfo: toRuntimeSourceInfo(filePath, resource.metadata),
          enabled: resource.enabled,
          disableModelInvocation,
          slashCommand: skillSlashCommand(name),
        } satisfies RuntimeSkillRecord;
      }),
    );

    return records.sort(
      (left: RuntimeSkillRecord, right: RuntimeSkillRecord) =>
        compareEnabledFirst(left.enabled, right.enabled) || left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath),
    );
  }

  private async buildExtensionRecords(
    context: RuntimeContext,
    resolvedExtensions: readonly ResolvedResource[],
  ): Promise<readonly RuntimeExtensionRecord[]> {
    const loadedResult = context.resourceLoader.getExtensions();
    const packageMetadataCache = new Map<string, Promise<PackageMetadata>>();
    const loadedByPath = new Map(
      loadedResult.extensions.map((extension) => [resolve(extension.resolvedPath || extension.path), extension] as const),
    );
    const diagnosticsByPath = new Map<string, RuntimeExtensionDiagnostic[]>();

    for (const error of loadedResult.errors) {
      const diagnostics = diagnosticsByPath.get(resolve(error.path)) ?? [];
      diagnostics.push({
        type: "error",
        message: error.error,
        path: error.path,
      });
      diagnosticsByPath.set(resolve(error.path), diagnostics);
    }

    const records = await Promise.all(
      resolvedExtensions.map<Promise<RuntimeExtensionRecord>>(async (resource) => {
        const path = resolve(resource.path);
        const loaded = loadedByPath.get(path);
        const packageMetadata = await inferExtensionPackageMetadata(resource.metadata, packageMetadataCache);
        return {
          path,
          displayName: packageMetadata?.displayName ?? inferExtensionEntryName(path),
          ...(packageMetadata?.description ? { description: packageMetadata.description } : {}),
          enabled: resource.enabled,
          sourceInfo: toRuntimeSourceInfo(path, resource.metadata),
          commands: loaded ? [...loaded.commands.keys()].sort((left, right) => left.localeCompare(right)) : [],
          tools: loaded
            ? [...loaded.tools.values()]
                .map((tool) => tool.definition.name)
                .sort((left, right) => left.localeCompare(right))
            : [],
          flags: loaded ? [...loaded.flags.keys()].sort((left, right) => left.localeCompare(right)) : [],
          shortcuts: loaded ? [...loaded.shortcuts.keys()].sort((left, right) => left.localeCompare(right)) : [],
          diagnostics: diagnosticsByPath.get(path) ?? [],
        };
      }),
    );
    const resolvedRecordPaths = new Set(records.map((record) => resolve(record.path)));
    const inlineRecords = loadedResult.extensions
      .filter((extension) => extension.path.startsWith("<inline:") && !resolvedRecordPaths.has(resolve(extension.path)))
      .map((extension) => this.buildInlineExtensionRecord(extension));
    records.push(...inlineRecords);

    return records.sort(
      (left, right) =>
        compareEnabledFirst(left.enabled, right.enabled) ||
        (left.displayName === right.displayName ? left.path.localeCompare(right.path) : left.displayName.localeCompare(right.displayName)),
    );
  }

  private async buildPackageRecords(
    context: RuntimeContext,
    resolvedPaths: ResolvedPaths,
  ): Promise<readonly RuntimePackageRecord[]> {
    return this.packageInstaller.listPackages(context, resolvedPaths);
  }

  private async repairBrokenNativePackages(context: RuntimeContext): Promise<void> {
    const extensionErrors = context.resourceLoader.getExtensions().errors;
    if (extensionErrors.length === 0) {
      return;
    }

    const resolvedPaths = await this.resolveRuntimePaths(context);
    const packageResourcesByPath = new Map(
      resolvedPaths.extensions
        .filter((resource) => resource.metadata.origin === "package")
        .map((resource) => [resolve(resource.path), resource] as const),
    );

    const mismatchedSources = new Set<string>();
    for (const error of extensionErrors) {
      if (!isNativeModuleVersionMismatch(error.error)) {
        continue;
      }

      const resource = packageResourcesByPath.get(resolve(error.path));
      if (!resource) {
        continue;
      }

      mismatchedSources.add(resource.metadata.source);
    }

    if (mismatchedSources.size === 0) {
      return;
    }

    let repaired = false;
    for (const source of mismatchedSources) {
      try {
        repaired = (await this.packageInstaller.repairPackageForCurrentHost(context, source)) || repaired;
      } catch (error) {
        console.warn(
          `[pi-gui] Failed to rebuild native package ${source} for Electron: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (repaired) {
      await context.resourceLoader.reload();
    }
  }

  private buildInlineExtensionRecord(extension: ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number]): RuntimeExtensionRecord {
    const metadata = inlineExtensionMetadataForPath(extension.path, this.inlineExtensionMetadata);
    return {
      path: extension.path,
      displayName: metadata.displayName,
      ...(metadata.description ? { description: metadata.description } : {}),
      enabled: true,
      sourceInfo: {
        path: extension.path,
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
      commands: [...extension.commands.keys()].sort((left, right) => left.localeCompare(right)),
      tools: [...extension.tools.values()]
        .map((tool) => tool.definition.name)
        .sort((left, right) => left.localeCompare(right)),
      flags: [...extension.flags.keys()].sort((left, right) => left.localeCompare(right)),
      shortcuts: [...extension.shortcuts.keys()].sort((left, right) => left.localeCompare(right)),
      diagnostics: [],
    };
  }

  private toggleResource(
    context: RuntimeContext,
    resource: ResolvedResource,
    enabled: boolean,
    kind: ToggleableResourceKind,
  ): void {
    const { settingsManager } = context;
    const scope = resource.metadata.scope;
    if (scope !== "project" && scope !== "user") {
      throw new Error(`Cannot update ${kind} at scope ${scope}`);
    }
    const origin = resource.metadata.origin;
    const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
    const pattern = this.relativeResourcePattern(resource.path, resource.metadata, scope, origin);

    if (origin === "top-level") {
      const currentPaths = kind === "skill" ? [...(settings.skills ?? [])] : [...(settings.extensions ?? [])];
      const updated = replaceResourcePattern(currentPaths, pattern, enabled);
      this.setTopLevelResourcePaths(settingsManager, scope, kind, updated);
      return;
    }

    const packages = [...(settings.packages ?? [])];
    const source = resource.metadata.source;
    const packageIndex = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
    if (packageIndex < 0) {
      throw new Error(`${titleForResourceKind(kind)} package source not found for ${resource.path}`);
    }

    const currentPackage = packages[packageIndex];
    const nextPackage = typeof currentPackage === "string" ? { source: currentPackage } : { ...currentPackage };
    const currentPatterns = kind === "skill" ? [...(nextPackage.skills ?? [])] : [...(nextPackage.extensions ?? [])];
    const updatedPatterns = replaceResourcePattern(currentPatterns, pattern, enabled);
    if (updatedPatterns.length > 0) {
      if (kind === "skill") {
        nextPackage.skills = updatedPatterns;
      } else {
        nextPackage.extensions = updatedPatterns;
      }
    } else {
      if (kind === "skill") {
        delete nextPackage.skills;
      } else {
        delete nextPackage.extensions;
      }
    }

    const hasFilters = ["skills", "extensions", "prompts", "themes"].some((key) =>
      Object.prototype.hasOwnProperty.call(nextPackage, key),
    );
    packages[packageIndex] = (hasFilters ? nextPackage : nextPackage.source) as PackageSource;

    if (scope === "project") {
      settingsManager.setProjectPackages(packages);
    } else {
      settingsManager.setPackages(packages);
    }
  }

  private setTopLevelResourcePaths(
    settingsManager: SettingsManager,
    scope: ResourceScope,
    kind: ToggleableResourceKind,
    paths: string[],
  ): void {
    if (kind === "skill") {
      if (scope === "project") {
        settingsManager.setProjectSkillPaths(paths);
      } else {
        settingsManager.setSkillPaths(paths);
      }
      return;
    }

    if (scope === "project") {
      settingsManager.setProjectExtensionPaths(paths);
    } else {
      settingsManager.setExtensionPaths(paths);
    }
  }

  private relativeResourcePattern(
    filePath: string,
    metadata: PathMetadata,
    scope: ResourceScope,
    origin: PathMetadata["origin"],
  ): string {
    if (origin === "package") {
      const baseDir = metadata.baseDir ?? dirname(filePath);
      return relative(baseDir, filePath);
    }

    const baseDir = metadata.baseDir ?? (scope === "project" ? dirname(filePath) : this.agentDir);
    return relative(baseDir, filePath);
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function compareEnabledFirst(leftEnabled: boolean, rightEnabled: boolean): number {
  return Number(rightEnabled) - Number(leftEnabled);
}

function replaceResourcePattern(patterns: readonly string[], resourcePattern: string, enabled: boolean): string[] {
  const next = patterns.filter((pattern) => stripPrefix(pattern) !== resourcePattern);
  next.push(`${enabled ? "+" : "-"}${resourcePattern}`);
  return next;
}

function removeResourcePattern(patterns: readonly string[], resourcePattern: string): string[] {
  return patterns.filter((pattern) => stripPrefix(pattern) !== resourcePattern);
}

function stripPrefix(pattern: string): string {
  return pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

async function readSkillMetadata(
  filePath: string,
): Promise<{ name?: string; description?: string; disableModelInvocation?: boolean } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(raw) as
      | {
          name?: string;
          description?: string;
          "disable-model-invocation"?: boolean;
        }
      | undefined;
    const body = stripFrontmatter(raw);
    const metadata: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
    if (frontmatter?.name) {
      metadata.name = frontmatter.name;
    }
    const description = frontmatter?.description ?? firstNonEmptyLine(body);
    if (description) {
      metadata.description = description;
    }
    if (frontmatter?.["disable-model-invocation"] !== undefined) {
      metadata.disableModelInvocation = frontmatter["disable-model-invocation"];
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function inferSkillName(filePath: string): string {
  const parent = basename(dirname(filePath));
  if (basename(filePath).toLowerCase() === "skill.md" && parent) {
    return parent;
  }
  return basename(filePath).replace(/\.md$/i, "");
}

async function inferExtensionPackageMetadata(
  metadata: PathMetadata,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata | undefined> {
  if (metadata.origin === "package" && metadata.baseDir) {
    return inferPackageMetadata(metadata.baseDir, packageMetadataCache);
  }
  return undefined;
}

function inferExtensionEntryName(filePath: string): string {
  return basename(filePath).replace(/\.(c|m)?(t|j)sx?$/i, "");
}

async function inferPackageMetadata(
  packageRoot: string,
  packageMetadataCache: Map<string, Promise<PackageMetadata>>,
): Promise<PackageMetadata> {
  const normalizedRoot = resolve(packageRoot);
  const cached = packageMetadataCache.get(normalizedRoot);
  if (cached) {
    return cached;
  }

  const pending = readPackageMetadata(normalizedRoot);
  packageMetadataCache.set(normalizedRoot, pending);
  return pending;
}

async function readPackageMetadata(packageRoot: string): Promise<PackageMetadata> {
  const folderName = basename(packageRoot).trim();
  const packageJson = await readJsonRecord(join(packageRoot, "package.json")) as {
    readonly displayName?: unknown;
    readonly description?: unknown;
  };
  const displayName =
    typeof packageJson.displayName === "string" && packageJson.displayName.trim()
      ? packageJson.displayName.trim()
      : folderName;
  const description =
    typeof packageJson.description === "string" && packageJson.description.trim()
      ? packageJson.description.trim()
      : undefined;

  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
  };
}

// Keep this aligned with the Pi runtime providers that explicitly accept a
// desktop-saved API key or token. Ambient credential providers such as
// amazon-bedrock are intentionally excluded.
const DESKTOP_API_KEY_PROVIDER_IDS = new Set([
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
]);

function providerSupportsDesktopApiKeySetup(providerId: string): boolean {
  return DESKTOP_API_KEY_PROVIDER_IDS.has(providerId);
}

function inferProviderAuthSource(
  auth: { readonly type: "oauth" | "api_key" } | undefined,
  providerAuthStatus: AuthStatus,
  apiKeySetupSupported: boolean,
): "none" | "oauth" | "auth_file" | "env" | "external" {
  if (auth?.type === "oauth") {
    return "oauth";
  }
  if (auth?.type === "api_key") {
    return "auth_file";
  }
  switch (providerAuthStatus.source) {
    case "stored":
      return "auth_file";
    case "environment":
      return "env";
    case "fallback":
    case "models_json_command":
    case "models_json_key":
    case "runtime":
      return "external";
  }
  if (!providerAuthStatus.configured) {
    return "none";
  }
  return apiKeySetupSupported ? "env" : "external";
}

function toRuntimeSourceInfo(path: string, metadata: PathMetadata): RuntimeSourceInfo {
  return {
    path,
    source: metadata.source,
    scope: metadata.scope,
    origin: metadata.origin,
    ...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
  };
}

function inlineExtensionMetadataForPath(
  path: string,
  metadata: readonly RuntimeInlineExtensionMetadata[],
): RuntimeInlineExtensionMetadata {
  const match = /^<inline:(\d+)>$/.exec(path);
  const index = match?.[1] ? Number.parseInt(match[1], 10) - 1 : -1;
  return metadata[index] ?? { displayName: path };
}

function titleForResourceKind(kind: ToggleableResourceKind): string {
  return kind === "skill" ? "Skill" : "Extension";
}

function isNativeModuleVersionMismatch(message: string): boolean {
  return message.includes("NODE_MODULE_VERSION") && message.includes("compiled against a different Node.js version");
}

function toModelSettingsSnapshot(settings: Record<string, unknown>): ModelSettingsSnapshot {
  return {
    enabledModelPatterns: Array.isArray(settings.enabledModels)
      ? settings.enabledModels.filter((value): value is string => typeof value === "string")
      : [],
    ...(typeof settings.defaultProvider === "string" ? { defaultProvider: settings.defaultProvider } : {}),
    ...(typeof settings.defaultModel === "string" ? { defaultModelId: settings.defaultModel } : {}),
    ...(typeof settings.defaultThinkingLevel === "string"
      ? { defaultThinkingLevel: settings.defaultThinkingLevel as ModelSettingsSnapshot["defaultThinkingLevel"] }
      : {}),
  } satisfies ModelSettingsSnapshot;
}

function mergeEnabledModelPatterns(
  existingPatterns: readonly string[],
  providerPatterns: readonly string[],
): readonly string[] {
  const merged = [...existingPatterns];
  const seen = new Set(existingPatterns);
  for (const pattern of providerPatterns) {
    if (seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    merged.push(pattern);
  }
  return merged;
}

function pruneStaleExactModelPatterns(
  patterns: readonly string[],
  models: readonly RuntimeModelRecord[],
  providers: readonly RuntimeProviderRecord[],
): readonly string[] {
  const knownProviderIds = new Set([
    ...providers.map((provider) => provider.id.toLowerCase()),
    ...models.map((model) => model.providerId.toLowerCase()),
  ]);
  const availableModelIds = new Set(
    models
      .filter((model) => model.available)
      .map((model) => `${model.providerId}/${model.modelId}`.toLowerCase()),
  );

  return patterns.filter((pattern) => {
    const exactPattern = parseExactModelPattern(pattern);
    if (!exactPattern || !knownProviderIds.has(exactPattern.providerId.toLowerCase())) {
      return true;
    }
    return availableModelIds.has(`${exactPattern.providerId}/${exactPattern.modelId}`.toLowerCase());
  });
}

function patternReferencesAvailableModel(pattern: string, availableModelIds: ReadonlySet<string>): boolean {
  const exactPattern = parseExactModelPattern(pattern);
  return exactPattern
    ? availableModelIds.has(`${exactPattern.providerId}/${exactPattern.modelId}`.toLowerCase())
    : false;
}

function parseExactModelPattern(pattern: string): { providerId: string; modelId: string } | undefined {
  if (/[?*\[]/.test(pattern)) {
    return undefined;
  }

  const slashIndex = pattern.indexOf("/");
  if (slashIndex <= 0 || slashIndex === pattern.length - 1) {
    return undefined;
  }

  const providerId = pattern.substring(0, slashIndex).trim();
  let modelId = pattern.substring(slashIndex + 1).trim();
  const lastColonIndex = modelId.lastIndexOf(":");
  if (lastColonIndex !== -1 && isThinkingLevel(modelId.substring(lastColonIndex + 1))) {
    modelId = modelId.substring(0, lastColonIndex);
  }

  if (!providerId || !modelId) {
    return undefined;
  }
  return { providerId, modelId };
}

function isThinkingLevel(value: string): boolean {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function modelPatternsAreEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((pattern, index) => pattern === right[index]);
}

function setEnabledModelPatternsForActiveScope(
  settingsManager: SettingsManager,
  patterns: readonly string[],
): void {
  const nextPatterns = patterns.length > 0 ? [...patterns] : undefined;
  const projectSettings = settingsManager.getProjectSettings() as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(projectSettings, "enabledModels")) {
    const writableSettingsManager = settingsManager as unknown as ProjectWritableSettingsManager;
    projectSettings.enabledModels = nextPatterns;
    writableSettingsManager.markProjectModified("enabledModels");
    writableSettingsManager.saveProjectSettings(projectSettings);
    return;
  }

  settingsManager.setEnabledModels(nextPatterns);
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
