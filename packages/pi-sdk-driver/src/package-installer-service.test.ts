import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";
import { PackageInstallerService } from "./package-installer-service.js";

type JsonRecord = Record<string, unknown>;

function createMemoryStorage(initial: { global?: JsonRecord; project?: JsonRecord } = {}) {
  const values = new Map<"global" | "project", string | undefined>();
  if (initial.global) {
    values.set("global", JSON.stringify(initial.global));
  }
  if (initial.project) {
    values.set("project", JSON.stringify(initial.project));
  }

  return {
    withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined) {
      const next = fn(values.get(scope));
      if (next !== undefined) {
        values.set(scope, next);
      }
    },
  };
}

function createContext(settings: { global?: JsonRecord; project?: JsonRecord } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-gui-package-installer-"));
  const settingsManager = SettingsManager.fromStorage(createMemoryStorage(settings));
  const packageManager = new DefaultPackageManager({
    cwd: tempDir,
    agentDir: tempDir,
    settingsManager,
  });

  return {
    tempDir,
    settingsManager,
    packageManager,
    service: new PackageInstallerService(),
    cleanup() {
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
}

test("disabling a globally installed package resource creates a project override", async () => {
  const context = createContext({
    global: {
      packages: ["npm:pi-web-access@1.0.0"],
    },
  });

  try {
    await context.service.setPackageResourceEnabled(
      {
        packageManager: context.packageManager,
        settingsManager: context.settingsManager,
      },
      {
        path: join(context.tempDir, "global-package", "extensions", "index.ts"),
        enabled: true,
        metadata: {
          source: "npm:pi-web-access@1.0.0",
          scope: "user",
          origin: "package",
          baseDir: join(context.tempDir, "global-package"),
        },
      },
      "extension",
      false,
    );

    assert.deepEqual(context.settingsManager.getProjectSettings().packages, [
      {
        source: "npm:pi-web-access@1.0.0",
        extensions: ["-extensions/index.ts"],
      },
    ]);
  } finally {
    context.cleanup();
  }
});

test("installing a package rebuilds native modules for the Electron host", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-gui-package-rebuild-"));
  const installedPath = join(tempDir, "node_modules", "pi-native-test");
  const recordPath = join(tempDir, "rebuild-record.json");
  const commandPath = join(tempDir, "mock-npm.mjs");
  const originalVersions = process.versions;
  let installedSource: string | undefined;
  mkdirSync(installedPath, { recursive: true });

  writeFileSync(
    commandPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.MOCK_RECORD_PATH, JSON.stringify({",
      "  cwd: process.cwd(),",
      "  args: process.argv.slice(2),",
      "  runtime: process.env.npm_config_runtime,",
      "  target: process.env.npm_config_target,",
      "  disturl: process.env.npm_config_disturl,",
      "  devdir: process.env.npm_config_devdir,",
      "}, null, 2));",
    ].join("\n"),
  );
  chmodSync(commandPath, 0o755);

  const settingsManager = SettingsManager.fromStorage(createMemoryStorage());
  settingsManager.getNpmCommand = () => [process.execPath, commandPath];

  const packageManager = {
    installAndPersist: async (source: string) => {
      installedSource = source;
    },
    getInstalledPath: (source: string, scope: string) =>
      source === "npm:pi-native-test" && scope === "user" ? installedPath : undefined,
  } as unknown as DefaultPackageManager;

  const originalEnv = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: {
      ...process.versions,
      electron: "34.5.8",
    },
  });

  try {
    const service = new PackageInstallerService();
    await service.installPackage(
      {
        packageManager,
        settingsManager,
      },
      "npm:pi-native-test",
    );

    assert.equal(installedSource, "npm:pi-native-test");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, string | string[]>;
    assert.equal(record.cwd, realpathSync(installedPath));
    assert.deepEqual(record.args, ["rebuild"]);
    assert.equal(record.runtime, "electron");
    assert.equal(record.target, "34.5.8");
    assert.equal(record.disturl, "https://electronjs.org/headers");
    assert.match(String(record.devdir), /\.electron-gyp$/);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = originalEnv;
    }
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: originalVersions,
    });
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("updating an unpinned package delegates to the package manager update flow", async () => {
  const settingsManager = SettingsManager.fromStorage(createMemoryStorage({
    global: {
      packages: ["npm:pi-web-access"],
    },
  }));
  const updatedSources: string[] = [];
  const packageManager = {
    update: async (source: string) => {
      updatedSources.push(source);
    },
    getInstalledPath: () => undefined,
  } as unknown as DefaultPackageManager;

  const service = new PackageInstallerService();
  await service.updatePackage(
    {
      packageManager,
      settingsManager,
    },
    "npm:pi-web-access",
  );

  assert.deepEqual(updatedSources, ["npm:pi-web-access"]);
});

test("updating a pinned npm package reinstalls its floating package spec in configured scopes", async () => {
  const settingsManager = SettingsManager.fromStorage(createMemoryStorage({
    global: {
      packages: ["npm:pi-web-access@1.0.0"],
    },
    project: {
      packages: ["npm:pi-web-access@1.0.0"],
    },
  }));
  const installCalls: Array<{ source: string; options?: { local?: boolean } | undefined }> = [];
  const packageManager = {
    installAndPersist: async (source: string, options?: { local?: boolean }) => {
      installCalls.push({ source, options });
    },
    getInstalledPath: () => undefined,
  } as unknown as DefaultPackageManager;

  const service = new PackageInstallerService();
  await service.updatePackage(
    {
      packageManager,
      settingsManager,
    },
    "npm:pi-web-access@1.0.0",
  );

  assert.deepEqual(installCalls, [
    { source: "npm:pi-web-access", options: undefined },
    { source: "npm:pi-web-access", options: { local: true } },
  ]);
});

test("disabling a package for one project writes an all-resources project override", async () => {
  const context = createContext({
    global: {
      packages: ["npm:pi-web-access@1.0.0"],
    },
  });

  try {
    await context.service.setPackageEnabled(
      {
        packageManager: context.packageManager,
        settingsManager: context.settingsManager,
      },
      "npm:pi-web-access@1.0.0",
      false,
    );

    assert.deepEqual(context.settingsManager.getProjectSettings().packages, [
      {
        source: "npm:pi-web-access@1.0.0",
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      },
    ]);
  } finally {
    context.cleanup();
  }
});

test("listing packages merges a user install with its project override", async () => {
  const context = createContext({
    global: {
      packages: ["npm:pi-web-access@1.0.0"],
    },
    project: {
      packages: [
        {
          source: "npm:pi-web-access@1.0.0",
          extensions: [],
        },
      ],
    },
  });

  try {
    const records = await context.service.listPackages(
      {
        packageManager: context.packageManager,
        settingsManager: context.settingsManager,
      },
      {
        extensions: [
          {
            path: join(context.tempDir, "project-package", "extensions", "index.ts"),
            enabled: false,
            metadata: {
              source: "npm:pi-web-access@1.0.0",
              scope: "project",
              origin: "package",
              baseDir: join(context.tempDir, "project-package"),
            },
          },
        ],
        skills: [],
        prompts: [],
        themes: [],
      } satisfies ResolvedPaths,
    );

    assert.deepEqual(records, [
      {
        source: "npm:pi-web-access@1.0.0",
        sourceType: "npm",
        installScope: "user",
        projectOverride: true,
        enabled: false,
        filters: {
          extensions: [],
        },
      },
    ]);
  } finally {
    context.cleanup();
  }
});
