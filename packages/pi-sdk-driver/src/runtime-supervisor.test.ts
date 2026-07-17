import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { RuntimeSupervisor } from "./runtime-supervisor.js";

interface ProjectWritableSettingsManager {
  markProjectModified(field: string, nestedKey?: string): void;
  saveProjectSettings(settings: Record<string, unknown>): void;
}

test("runtime supervisor repairs package-backed extensions that fail with a Node module ABI mismatch", async () => {
  const supervisor = new RuntimeSupervisor() as unknown as {
    packageInstaller: {
      repairPackageForCurrentHost(context: unknown, source: string): Promise<boolean>;
    };
    resolveRuntimePaths(context: unknown): Promise<{
      extensions: Array<{
        path: string;
        enabled: boolean;
        metadata: {
          source: string;
          origin: "package";
        };
      }>;
      skills: [];
      prompts: [];
      themes: [];
    }>;
    repairBrokenNativePackages(context: unknown): Promise<void>;
  };

  const repairedSources: string[] = [];
  let reloadCount = 0;
  const failingPath = "/tmp/context-mode/build/adapters/pi/extension.js";
  const context = {
    resourceLoader: {
      getExtensions() {
        return {
          extensions: [],
          errors: [
            {
              path: failingPath,
              error:
                "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 132.",
            },
          ],
        };
      },
      async reload() {
        reloadCount += 1;
      },
    },
  };

  supervisor.packageInstaller = {
    async repairPackageForCurrentHost(_context: unknown, source: string) {
      repairedSources.push(source);
      return true;
    },
  };
  supervisor.resolveRuntimePaths = async () => ({
    extensions: [
      {
        path: failingPath,
        enabled: false,
        metadata: {
          source: "npm:context-mode",
          origin: "package",
        },
      },
    ],
    skills: [],
    prompts: [],
    themes: [],
  });

  await supervisor.repairBrokenNativePackages(context);

  assert.deepEqual(repairedSources, ["npm:context-mode"]);
  assert.equal(reloadCount, 1);
});

test("runtime supervisor prunes stale exact model patterns when reconciling model scope", async () => {
  const settingsManager = SettingsManager.inMemory({
    enabledModels: [
      "openai-codex/gpt-5.1",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.5:high",
      "openai-codex/gpt-*",
      "gpt-5",
      "unknown-provider/custom-model",
    ],
  });
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildProviderRecords(): Promise<unknown[]>;
    buildModelRecords(): Promise<unknown[]>;
    reconcileEnabledModelPatterns(context: unknown, providerIds?: readonly string[]): Promise<void>;
  };
  supervisor.buildProviderRecords = async () => [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      hasAuth: true,
      authType: "oauth",
      authSource: "oauth",
      oauthSupported: true,
      apiKeySetupSupported: false,
    },
  ];
  supervisor.buildModelRecords = async () => [
    {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      modelId: "gpt-5.5",
      label: "GPT 5.5",
      available: true,
      authType: "oauth",
      reasoning: true,
      supportsImages: false,
    },
  ];

  await supervisor.reconcileEnabledModelPatterns({ settingsManager });

  assert.deepEqual(settingsManager.getEnabledModels(), [
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.5:high",
    "openai-codex/gpt-*",
    "gpt-5",
    "unknown-provider/custom-model",
  ]);
});

test("runtime supervisor adds newly available provider models after pruning stale scope", async () => {
  const settingsManager = SettingsManager.inMemory({
    enabledModels: ["openai-codex/gpt-5.1"],
  });
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildProviderRecords(): Promise<unknown[]>;
    buildModelRecords(): Promise<unknown[]>;
    reconcileEnabledModelPatterns(context: unknown, providerIds?: readonly string[]): Promise<void>;
  };
  supervisor.buildProviderRecords = async () => [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      hasAuth: true,
      authType: "oauth",
      authSource: "oauth",
      oauthSupported: true,
      apiKeySetupSupported: false,
    },
  ];
  supervisor.buildModelRecords = async () => [
    {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      modelId: "gpt-5.5",
      label: "GPT 5.5",
      available: true,
      authType: "oauth",
      reasoning: true,
      supportsImages: false,
    },
  ];

  await supervisor.reconcileEnabledModelPatterns({ settingsManager }, ["openai-codex"]);

  assert.deepEqual(settingsManager.getEnabledModels(), ["openai-codex/gpt-5.5"]);
});

test("runtime supervisor treats thinking-level exact patterns as selectable models", async () => {
  const settingsManager = SettingsManager.inMemory({
    enabledModels: ["openai-codex/gpt-5.5:high"],
  });
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildProviderRecords(): Promise<unknown[]>;
    buildModelRecords(): Promise<unknown[]>;
    reconcileEnabledModelPatterns(context: unknown, providerIds?: readonly string[]): Promise<void>;
  };
  supervisor.buildProviderRecords = async () => [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      hasAuth: true,
      authType: "oauth",
      authSource: "oauth",
      oauthSupported: true,
      apiKeySetupSupported: false,
    },
  ];
  supervisor.buildModelRecords = async () => [
    {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      modelId: "gpt-5.5",
      label: "GPT 5.5",
      available: true,
      authType: "oauth",
      reasoning: true,
      supportsImages: false,
    },
  ];

  await supervisor.reconcileEnabledModelPatterns({ settingsManager });

  assert.deepEqual(settingsManager.getEnabledModels(), ["openai-codex/gpt-5.5:high"]);
});

test("runtime supervisor writes pruned model scope back to project settings when project overrides models", async () => {
  const settingsManager = SettingsManager.inMemory({
    enabledModels: ["openai-codex/gpt-5.5"],
  });
  const writableSettingsManager = settingsManager as unknown as ProjectWritableSettingsManager;
  writableSettingsManager.markProjectModified("enabledModels");
  writableSettingsManager.saveProjectSettings({
    enabledModels: ["openai-codex/gpt-5.1", "openai-codex/gpt-5.5"],
  });
  await settingsManager.flush();
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildProviderRecords(): Promise<unknown[]>;
    buildModelRecords(): Promise<unknown[]>;
    reconcileEnabledModelPatterns(context: unknown, providerIds?: readonly string[]): Promise<void>;
  };
  supervisor.buildProviderRecords = async () => [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      hasAuth: true,
      authType: "oauth",
      authSource: "oauth",
      oauthSupported: true,
      apiKeySetupSupported: false,
    },
  ];
  supervisor.buildModelRecords = async () => [
    {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      modelId: "gpt-5.5",
      label: "GPT 5.5",
      available: true,
      authType: "oauth",
      reasoning: true,
      supportsImages: false,
    },
  ];

  await supervisor.reconcileEnabledModelPatterns({ settingsManager });
  await settingsManager.reload();

  assert.deepEqual(settingsManager.getProjectSettings().enabledModels, ["openai-codex/gpt-5.5"]);
  assert.deepEqual(settingsManager.getGlobalSettings().enabledModels, ["openai-codex/gpt-5.5"]);
});

test("runtime supervisor skips eager runtime refresh before external launch on Windows", async () => {
  const supervisor = new RuntimeSupervisor() as unknown as {
    refreshRuntime(workspace: unknown): Promise<void>;
    prepareRuntimeForExternalLaunch(workspace: unknown): Promise<void>;
  };

  let refreshCalls = 0;
  supervisor.refreshRuntime = async () => {
    refreshCalls += 1;
  };

  await withPlatform("win32", async () => {
    await supervisor.prepareRuntimeForExternalLaunch({
      workspaceId: "workspace",
      path: "C:\\workspace",
    });
  });

  assert.equal(refreshCalls, 0);
});

test("runtime supervisor sorts enabled skills before disabled skills and keeps alphabetical order within each group", async () => {
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildSkillRecords(context: unknown, resolvedSkills: readonly unknown[]): Promise<readonly { enabled: boolean; name: string }[]>;
  };
  const context = {
    resourceLoader: {
      getSkills() {
        return {
          skills: [
            loadedSkillRecord("/workspace/alpha-disabled.md", "Alpha Disabled Skill"),
            loadedSkillRecord("/workspace/zulu-enabled.md", "Zulu Enabled Skill"),
            loadedSkillRecord("/workspace/bravo-disabled.md", "Bravo Disabled Skill"),
            loadedSkillRecord("/workspace/mike-enabled.md", "Mike Enabled Skill"),
          ],
        };
      },
      getExtensions() {
        return { extensions: [], errors: [] };
      },
    },
  };

  const records = await supervisor.buildSkillRecords(context, [
    resolvedResource("/workspace/alpha-disabled.md", false),
    resolvedResource("/workspace/zulu-enabled.md", true),
    resolvedResource("/workspace/bravo-disabled.md", false),
    resolvedResource("/workspace/mike-enabled.md", true),
  ]);

  assert.deepEqual(records.map((record) => `${record.enabled ? "enabled" : "disabled"}:${record.name}`), [
    "enabled:Mike Enabled Skill",
    "enabled:Zulu Enabled Skill",
    "disabled:Alpha Disabled Skill",
    "disabled:Bravo Disabled Skill",
  ]);
});

test("runtime supervisor sorts enabled extensions before disabled extensions and keeps alphabetical order within each group", async () => {
  const supervisor = new RuntimeSupervisor() as unknown as {
    buildExtensionRecords(context: unknown, resolvedExtensions: readonly unknown[]): Promise<readonly { enabled: boolean; displayName: string }[]>;
  };
  const context = {
    resourceLoader: {
      getSkills() {
        return { skills: [] };
      },
      getExtensions() {
        return {
          extensions: [
            loadedExtensionRecord("/workspace/alpha-disabled.js", "Alpha Disabled Extension"),
            loadedExtensionRecord("/workspace/zulu-enabled.js", "Zulu Enabled Extension"),
            loadedExtensionRecord("/workspace/bravo-disabled.js", "Bravo Disabled Extension"),
            loadedExtensionRecord("/workspace/mike-enabled.js", "Mike Enabled Extension"),
          ],
          errors: [],
        };
      },
    },
  };

  const records = await supervisor.buildExtensionRecords(context, [
    resolvedResource("/workspace/alpha-disabled.js", false),
    resolvedResource("/workspace/zulu-enabled.js", true),
    resolvedResource("/workspace/bravo-disabled.js", false),
    resolvedResource("/workspace/mike-enabled.js", true),
  ]);

  assert.deepEqual(records.map((record) => `${record.enabled ? "enabled" : "disabled"}:${record.displayName}`), [
    "enabled:mike-enabled",
    "enabled:zulu-enabled",
    "disabled:alpha-disabled",
    "disabled:bravo-disabled",
  ]);
});

function loadedSkillRecord(filePath: string, name: string) {
  return {
    filePath,
    name,
    description: `${name} description`,
    baseDir: "/workspace",
    disableModelInvocation: false,
  };
}

function loadedExtensionRecord(path: string, displayName: string) {
  return {
    path,
    displayName,
    resolvedPath: path,
    commands: new Map<string, unknown>(),
    tools: new Map<string, { definition: { name: string } }>(),
    flags: new Map<string, unknown>(),
    shortcuts: new Map<string, unknown>(),
  };
}

function resolvedResource(path: string, enabled: boolean) {
  return {
    path,
    enabled,
    metadata: {
      source: "workspace",
      scope: "project",
      origin: "top-level",
      baseDir: "/workspace",
    },
  };
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, "platform", originalDescriptor);
    }
  }
}
