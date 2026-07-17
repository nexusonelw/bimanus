import { execFileSync } from "node:child_process";
import { extractAll } from "@electron/asar";
import { constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const requiredPackages = [
  // Keep packaging-sensitive runtime transitive deps explicit; electron-builder
  // can omit hoisted pnpm dependencies even when local development resolves them.
  "@aws-sdk/token-providers",
  "@modelcontextprotocol/sdk",
  "@smithy/is-array-buffer",
  "@smithy/util-buffer-from",
  "@smithy/util-utf8",
  "@vscode/ripgrep",
  "@xterm/addon-clipboard",
  "@xterm/addon-fit",
  "@xterm/addon-web-links",
  "@xterm/xterm",
  "ajv",
  "ajv-formats",
  "ansi-regex",
  "balanced-match",
  "brace-expansion",
  "chalk",
  "data-uri-to-buffer",
  "glob",
  "hosted-git-info",
  "lru-cache",
  "mime-types",
  "minimatch",
  "node-pty",
  "parse5",
  "parse5-htmlparser2-tree-adapter",
  "proxy-agent",
  "retry",
  "strip-ansi",
  "undici",
  "yargs",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packagePlatform = (process.env.PI_APP_PACKAGE_PLATFORM ?? process.platform).trim().toLowerCase();
const packageArch = (
  process.env.PI_APP_PACKAGE_ARCH ??
  (packagePlatform === "win32" || packagePlatform === "darwin" ? process.arch : "")
).trim().toLowerCase();
const asarPath = resolveAsarPath(desktopDir, packagePlatform);
const notificationHelperPath =
  packagePlatform === "darwin"
    ? path.join(resolveMacAppContentsDir(asarPath), "MacOS", "pi-gui-notification-status-helper")
    : undefined;
const piCodingAgentPackageName = "@earendil-works/pi-coding-agent";
const requiredPiCodingAgentVersion = "0.80.6";
const packagedRuntimeImportChecks = [
  ["@earendil-works", "pi-ai", "dist", "providers", "google.js"],
  ["@earendil-works", "pi-ai", "dist", "bedrock-provider.js"],
  ["highlight.js", "lib", "index.js"],
  ["proxy-agent", "dist", "index.js"],
];

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app.asar not found at ${asarPath}. Run the packaging step first.`);
}

if (notificationHelperPath && !existsSync(notificationHelperPath)) {
  throw new Error(`Packaged app is missing notification helper: ${notificationHelperPath}`);
}
if (notificationHelperPath) {
  verifyMacExecutableArchitecture(path.join(resolveMacAppContentsDir(asarPath), "MacOS", "Bimanus"));
  verifyMacExecutableArchitecture(notificationHelperPath);
}

if (packagePlatform === "win32" || packagePlatform === "win") {
  verifyWindowsNodeRuntimeNotBundled(asarPath);
}

if (packagePlatform === "darwin") {
  verifyMacBundledNodeRuntime(asarPath);
}

const extractedDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-"));
try {
  extractAll(asarPath, extractedDir);

  verifyRequiredPackages(extractedDir);
  await verifyPackagedPiRuntime(extractedDir);
  await verifyPackagedRuntimeImports(extractedDir);
  await verifyNativeNodePty(asarPath);
  await verifyUnpackedPiTuiRuntime(asarPath);
} finally {
  rmSync(extractedDir, { recursive: true, force: true });
}

console.log(`Verified packaged runtime dependencies in ${asarPath}`);

function resolveAsarPath(desktopDir, packagePlatform) {
  if (packagePlatform === "darwin") {
    const releaseDir = path.join(desktopDir, "release");
    const preferredDirNames =
      packageArch === "x64"
        ? ["mac", "mac-x64"]
        : packageArch === "arm64"
          ? ["mac-arm64"]
          : packageArch === "universal"
            ? ["mac-universal"]
            : ["mac-arm64", "mac", "mac-universal"];
    for (const dirName of preferredDirNames) {
      const candidatePath = path.join(releaseDir, dirName, "Bimanus.app", "Contents", "Resources", "app.asar");
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^mac(?:-[\w]+)?$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "Bimanus.app", "Contents", "Resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, preferredDirNames[0] ?? "mac-arm64", "Bimanus.app", "Contents", "Resources", "app.asar");
  }

  if (packagePlatform === "linux") {
    const releaseDir = path.join(desktopDir, "release");
    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^linux(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "linux-unpacked", "resources", "app.asar");
  }

  if (packagePlatform === "win32" || packagePlatform === "win") {
    const releaseDir = path.join(desktopDir, "release");
    const preferredDirNames =
      packageArch === "arm64"
        ? ["win-arm64-unpacked"]
        : packageArch === "x64"
          ? ["win-unpacked", "win-x64-unpacked"]
          : [];
    for (const dirName of preferredDirNames) {
      const candidatePath = path.join(releaseDir, dirName, "resources", "app.asar");
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^win(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "win-unpacked", "resources", "app.asar");
  }

  throw new Error(`Unsupported packaged runtime dependency target: ${packagePlatform}`);
}

function verifyRequiredPackages(extractedDir) {
  const missingPackages = requiredPackages.filter(
    (packageName) => !existsSync(path.join(extractedDir, "node_modules", packageName)),
  );

  if (missingPackages.length > 0) {
    throw new Error(`Packaged app is missing runtime dependencies: ${missingPackages.join(", ")}`);
  }
}

async function verifyPackagedPiRuntime(extractedDir) {
  const packageJsonPath = path.join(extractedDir, "node_modules", ...piCodingAgentPackageName.split("/"), "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== requiredPiCodingAgentVersion) {
    throw new Error(
      `Packaged app has ${piCodingAgentPackageName} ${packageJson.version}; expected ${requiredPiCodingAgentVersion}.`,
    );
  }

  const runtimeEntry = path.join(extractedDir, "node_modules", ...piCodingAgentPackageName.split("/"), "dist", "index.js");
  const { AuthStorage, ModelRegistry } = await import(pathToFileURL(runtimeEntry).href);
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const codexModel = registry.getAll().find((model) => model.provider === "openai-codex" && model.id === "gpt-5.5");
  if (!codexModel?.reasoning || !codexModel.input.includes("image")) {
    throw new Error("Packaged Pi runtime does not expose openai-codex/gpt-5.5 with reasoning and image input.");
  }
}

async function verifyPackagedRuntimeImports(extractedDir) {
  for (const modulePath of packagedRuntimeImportChecks) {
    const runtimeEntry = path.join(extractedDir, "node_modules", ...modulePath);
    await import(pathToFileURL(runtimeEntry).href);
  }
}

async function verifyNativeNodePty(asarPath) {
  const unpackedResourcesDir = `${asarPath}.unpacked`;
  const nodePtyDir = path.join(unpackedResourcesDir, "node_modules", "node-pty");
  if (!existsSync(nodePtyDir) || !hasFileWithExtension(nodePtyDir, ".node")) {
    throw new Error(`Packaged app is missing unpacked node-pty native module under ${nodePtyDir}`);
  }
  if (packagePlatform !== "darwin") {
    return;
  }
  const nativeDir = path.join(nodePtyDir, "prebuilds", `darwin-${packageArch}`);
  const ptyNodePath = path.join(nativeDir, "pty.node");
  const helperPath = path.join(nativeDir, "spawn-helper");
  if (!existsSync(ptyNodePath)) {
    throw new Error(`Packaged app is missing node-pty darwin-${packageArch} native module: ${ptyNodePath}`);
  }
  if (!existsSync(helperPath)) {
    throw new Error(`Packaged app is missing node-pty darwin-${packageArch} spawn-helper: ${helperPath}`);
  }
  verifyMacExecutableArchitecture(ptyNodePath);
  verifyMacExecutableArchitecture(helperPath);
  await access(helperPath, constants.X_OK);
}

function resolveMacAppContentsDir(packageAsarPath) {
  return path.dirname(path.dirname(packageAsarPath));
}

function verifyMacExecutableArchitecture(filePath) {
  if (packagePlatform !== "darwin" || (packageArch !== "x64" && packageArch !== "arm64")) {
    return;
  }
  const expected = packageArch === "x64" ? "x86_64" : "arm64";
  const info = execFileSync("file", [filePath], { encoding: "utf8" });
  if (!info.includes(expected)) {
    throw new Error(`Packaged Mach-O has wrong architecture for ${packageArch}: ${info.trim()}`);
  }
}

function verifyWindowsNodeRuntimeNotBundled(packageAsarPath) {
  const nodeRuntimeDir = path.join(path.dirname(packageAsarPath), "node-runtime");
  if (existsSync(nodeRuntimeDir)) {
    throw new Error(`Packaged Windows app must not bundle Node/npm runtime: ${nodeRuntimeDir}`);
  }
}

function verifyMacBundledNodeRuntime(packageAsarPath) {
  const nodeRuntimeDir = path.join(path.dirname(packageAsarPath), "node-runtime");
  const nodePath = path.join(nodeRuntimeDir, "node");
  if (!existsSync(nodePath)) {
    throw new Error(`Packaged macOS app is missing bundled Node runtime: ${nodePath}`);
  }
  verifyMacExecutableArchitecture(nodePath);

  const npmCliCandidates = [
    path.join(nodeRuntimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeRuntimeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (!npmCliPath) {
    throw new Error(
      `Packaged macOS app is missing bundled npm CLI under ${nodeRuntimeDir} (expected lib/node_modules/npm/bin/npm-cli.js). ` +
        `electron-builder strips root-level node_modules from extraResources; ensure prepare-macos-node-runtime and afterPack inject-macos-npm-runtime ran.`,
    );
  }

  if (process.platform === "darwin") {
    const npmVersion = execFileSync(nodePath, [npmCliPath, "--version"], { encoding: "utf8" }).trim();
    if (!/^\d+\.\d+\.\d+/.test(npmVersion)) {
      throw new Error(`Packaged macOS npm returned an invalid version via ${npmCliPath}: ${npmVersion}`);
    }
  }
}

async function verifyUnpackedPiTuiRuntime(asarPath) {
  if (packagePlatform !== "win32" && packagePlatform !== "win") {
    return;
  }
  const unpackedResourcesDir = `${asarPath}.unpacked`;
  const requiredUnpackedFiles = [
    ["node_modules", ...piCodingAgentPackageName.split("/"), "dist", "cli.js"],
    ["node_modules", "@vscode", "ripgrep", "package.json"],
    ["out", "mcp-bridge-extension", "dist", "index.js"],
  ];
  const missingFiles = requiredUnpackedFiles
    .map((segments) => path.join(unpackedResourcesDir, ...segments))
    .filter((candidatePath) => !existsSync(candidatePath));
  if (missingFiles.length > 0) {
    throw new Error(`Packaged Windows app is missing unpacked pi TUI runtime files: ${missingFiles.join(", ")}`);
  }
  const ripgrepPackageDir = path.join(unpackedResourcesDir, "node_modules", "@vscode");
  const ripgrepExecutable = findFileNamed(ripgrepPackageDir, "rg.exe");
  if (!ripgrepExecutable) {
    throw new Error(`Packaged Windows app is missing unpacked ripgrep executable under ${ripgrepPackageDir}`);
  }
  await import(pathToFileURL(path.join(unpackedResourcesDir, "out", "mcp-bridge-extension", "dist", "index.js")).href);
}

function hasFileWithExtension(directoryPath, extension) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) {
      return true;
    }
    if (entry.isDirectory() && hasFileWithExtension(entryPath, extension)) {
      return true;
    }
  }
  return false;
}

function findFileNamed(directoryPath, fileName) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nestedMatch = findFileNamed(entryPath, fileName);
      if (nestedMatch) {
        return nestedMatch;
      }
    }
  }
  return undefined;
}
