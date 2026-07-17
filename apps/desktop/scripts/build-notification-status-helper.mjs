import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const outputDir = path.join(desktopDir, "build", "native");
const macInheritEntitlementsPath = path.join(desktopDir, "resources", "entitlements.mac.inherit.plist");
const helpers = [
  {
    sourcePath: path.join(desktopDir, "resources", "notification-status-helper.swift"),
    outputPath: path.join(desktopDir, "build", "native", "pi-gui-notification-status-helper"),
  },
];
const mcpBridgeExtensionSourceDir = path.join(repoDir, "packages", "mcp-bridge-extension");
const mcpBridgeExtensionOutputDir = path.join(desktopDir, "out", "mcp-bridge-extension");
const universalMacTargets = [
  { arch: "arm64", target: "arm64-apple-macosx13.0" },
  { arch: "x86_64", target: "x86_64-apple-macosx13.0" },
];
const legacyCjsEntryShims = new Map([
  ["ajv", "dist/ajv.js"],
  ["ajv-formats", "dist/index.js"],
]);

await stageExtensionPackage("MCP Bridge", mcpBridgeExtensionSourceDir, mcpBridgeExtensionOutputDir);

if (process.platform !== "darwin") {
  console.log("Skipping notification status helper build outside macOS.");
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
for (const helper of helpers) {
  await buildUniversalSwiftExecutable(helper.sourcePath, helper.outputPath);
  console.log(`Built native helper at ${helper.outputPath}`);
}

await ensureRuntimeExecutablePermissions();

async function stageExtensionPackage(label, sourceDir, outputDir) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const packageJsonPath = path.join(sourceDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  await copyFile(packageJsonPath, path.join(outputDir, "package.json"));
  await cp(path.join(sourceDir, "dist"), path.join(outputDir, "dist"), {
    recursive: true,
  });
  await stageExtensionRuntimeDependencies(sourceDir, outputDir, Object.keys(packageJson.dependencies ?? {}));
  console.log(`Staged ${label} extension at ${outputDir}`);
}

async function stageExtensionRuntimeDependencies(sourceDir, outputDir, dependencyNames) {
  if (dependencyNames.length === 0) {
    return;
  }

  const outputNodeModulesDir = path.join(outputDir, "node_modules");
  await mkdir(outputNodeModulesDir, { recursive: true });

  // Copy only the transitive runtime dependency tree for this extension.
  // Never copy an entire workspace node_modules directory — under a hoisted
  // monorepo that would drag in electron/next/etc. and balloon the package.
  const stagedPackageNames = new Set();
  const pending = dependencyNames.map((dependencyName) => ({
    dependencyName,
    fromDir: sourceDir,
  }));

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) {
      continue;
    }
    const { dependencyName, fromDir } = next;
    if (stagedPackageNames.has(dependencyName)) {
      continue;
    }

    const packageDir = resolveDependencyPackageDir(fromDir, dependencyName);
    stagedPackageNames.add(dependencyName);
    await copyPackageToNodeModules(packageDir, dependencyName, outputNodeModulesDir);

    const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    for (const childName of Object.keys(packageJson.dependencies ?? {})) {
      pending.push({ dependencyName: childName, fromDir: packageDir });
    }
    for (const peerName of Object.keys(packageJson.peerDependencies ?? {})) {
      if (packageJson.peerDependenciesMeta?.[peerName]?.optional) {
        continue;
      }
      pending.push({ dependencyName: peerName, fromDir: packageDir });
    }
  }

  await ensureLegacyCjsEntryShims(outputNodeModulesDir);
}

function resolveDependencyPackageDir(fromDir, dependencyName) {
  // Prefer node's own resolution algorithm (walks up parent node_modules
  // directories) instead of assuming the dependency is hoisted directly
  // into `fromDir/node_modules`. This keeps things working under pnpm's
  // hoisted node-linker, where a cleanly-resolved dependency may only live
  // in the workspace root's node_modules rather than the package's own.
  //
  // Important: do NOT use path.dirname(require.resolve(.../package.json))
  // as the package root. Some packages (e.g. @modelcontextprotocol/sdk)
  // expose nested package.json files via exports, so resolution can land
  // inside dist/cjs. Walk up until package.json.name matches.
  const fromRequire = createRequire(path.join(fromDir, "package.json"));
  let resolvedPath;
  try {
    resolvedPath = fromRequire.resolve(`${dependencyName}/package.json`);
  } catch {
    resolvedPath = fromRequire.resolve(dependencyName);
  }

  let currentPath = path.dirname(resolvedPath);
  while (true) {
    const packageJsonPath = path.join(currentPath, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (packageJson.name === dependencyName) {
        return currentPath;
      }
    } catch {
      // keep walking
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Could not resolve package root for ${dependencyName} from ${fromDir} (started at ${resolvedPath})`);
    }
    currentPath = parentPath;
  }
}

async function copyPackageToNodeModules(packageDir, dependencyName, outputNodeModulesDir) {
  const destinationDir = path.join(outputNodeModulesDir, ...dependencyName.split("/"));
  await mkdir(path.dirname(destinationDir), { recursive: true });
  await cp(packageDir, destinationDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (source) => {
      // Runtime resolution uses the flat staged tree; skip nested installs.
      return path.basename(source) !== "node_modules";
    },
  });
}

async function ensureLegacyCjsEntryShims(outputNodeModulesDir) {
  for (const [packageName, mainPath] of legacyCjsEntryShims) {
    const packageDir = path.join(outputNodeModulesDir, ...packageName.split("/"));
    try {
      await writeFile(
        path.join(packageDir, "index.js"),
        `module.exports = require("./${mainPath}");\n`,
        "utf8",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function buildUniversalSwiftExecutable(sourcePath, outputPath) {
  const slices = universalMacTargets.map(({ arch }) => `${outputPath}.${arch}`);
  try {
    for (const target of universalMacTargets) {
      await execFileAsync("xcrun", ["swiftc", "-target", target.target, sourcePath, "-O", "-o", `${outputPath}.${target.arch}`], {
        cwd: desktopDir,
      });
    }
    await execFileAsync("xcrun", ["lipo", "-create", ...slices, "-output", outputPath], { cwd: desktopDir });
  } finally {
    await Promise.all(slices.map((slice) => rm(slice, { force: true })));
  }
  await chmod(outputPath, 0o755);
  await signNativeExecutable(outputPath);
}

async function signNativeExecutable(outputPath) {
  await execFileAsync(
    "codesign",
    ["--sign", "-", "--force", "--timestamp", "--options", "runtime", "--entitlements", macInheritEntitlementsPath, outputPath],
    { cwd: desktopDir },
  );
  await execFileAsync("codesign", ["--verify", "--strict", outputPath], { cwd: desktopDir });
}

async function ensureRuntimeExecutablePermissions() {
  const nodePtyDir = path.dirname(require.resolve("node-pty/package.json"));
  const runtimeExecutablePaths = [
    path.join(nodePtyDir, "prebuilds", "darwin-arm64", "spawn-helper"),
    path.join(nodePtyDir, "prebuilds", "darwin-x64", "spawn-helper"),
    optionalExecutablePath("@vscode/ripgrep-darwin-arm64/package.json", "bin", "rg"),
    optionalExecutablePath("@vscode/ripgrep-darwin-x64/package.json", "bin", "rg"),
  ].filter((filePath) => typeof filePath === "string");
  await Promise.all(runtimeExecutablePaths.map((filePath) => chmod(filePath, 0o755)));
}

function optionalExecutablePath(packageJsonPath, ...segments) {
  try {
    return path.join(path.dirname(require.resolve(packageJsonPath)), ...segments);
  } catch {
    return undefined;
  }
}

