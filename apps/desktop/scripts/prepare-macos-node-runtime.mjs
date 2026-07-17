import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "tar";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const targetArch = normalizeArch(readTargetArch());
const nodeVersion = process.versions.node;
const outputDir = path.join(desktopDir, "build", "native", "node-runtime", "darwin", targetArch);
const outputNodePath = path.join(outputDir, "node");
// Stage npm under lib/node_modules so electron-builder extraResources keeps it.
// app-builder-lib createFilter hard-excludes a root-level node_modules directory.
const outputNpmCliPath = path.join(outputDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
const outputNpxCliPath = path.join(outputDir, "lib", "node_modules", "npm", "bin", "npx-cli.js");

const archiveName = `node-v${nodeVersion}-darwin-${targetArch}.tar.gz`;
const cacheDir = path.join(desktopDir, "build", "cache", "node-runtime");
const archivePath = path.join(cacheDir, archiveName);
const extractDir = path.join(cacheDir, `node-v${nodeVersion}-darwin-${targetArch}`);
const extractedRuntimeDir = path.join(extractDir, `node-v${nodeVersion}-darwin-${targetArch}`);

mkdirSync(cacheDir, { recursive: true });
if (!existsSync(archivePath)) {
  await downloadFile(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archivePath);
}

rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
await extractTarGz(archivePath, extractDir);

verifyExtractedRuntime(extractedRuntimeDir);
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
stagePreparedRuntime(extractedRuntimeDir, outputDir);
logOutputDirectoryContents(outputDir);
verifyPreparedRuntime();
console.log(`Prepared macOS Node runtime for ${targetArch}: ${outputDir}`);

function readTargetArch() {
  const archFlag = process.argv.find((arg) => arg.startsWith("--arch="));
  if (archFlag) {
    return archFlag.slice("--arch=".length);
  }
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  return positional ?? process.arch;
}

function normalizeArch(value) {
  switch (value) {
    case "x64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported macOS Node runtime architecture: ${value}`);
  }
}

async function downloadFile(url, destinationPath) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  writeFileSync(destinationPath, Buffer.from(await response.arrayBuffer()));
}

async function extractTarGz(archivePath, destinationDir) {
  console.log(`Extracting ${archivePath} to ${destinationDir}`);
  await extract({
    file: archivePath,
    cwd: destinationDir,
  });
}

function verifyExtractedRuntime(runtimeDir) {
  const nodePath = path.join(runtimeDir, "bin", "node");
  const npmCliPath = path.join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npxCliPath = path.join(runtimeDir, "lib", "node_modules", "npm", "bin", "npx-cli.js");
  for (const requiredPath of [nodePath, npmCliPath, npxCliPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Downloaded Node archive did not contain ${requiredPath}`);
    }
  }
}

function stagePreparedRuntime(runtimeDir, destinationDir) {
  cpSync(path.join(runtimeDir, "bin", "node"), path.join(destinationDir, "node"));
  // Keep the official Node layout (lib/node_modules). A top-level node_modules
  // directory is stripped by electron-builder when copying extraResources.
  cpSync(path.join(runtimeDir, "lib", "node_modules"), path.join(destinationDir, "lib", "node_modules"), {
    recursive: true,
  });
}

function logOutputDirectoryContents(dir) {
  console.log(`Output directory: ${dir}`);
  logDirectoryTree(dir, "");
}

function logDirectoryTree(dir, prefix) {
  if (!existsSync(dir)) {
    console.log(`${prefix}(directory does not exist)`);
    return;
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  for (const file of files.slice(0, 20)) {
    console.log(`${prefix}  ${file.name}`);
  }
  if (files.length > 20) {
    console.log(`${prefix}  ... and ${files.length - 20} more files`);
  }
  for (const subdir of dirs.slice(0, 10)) {
    console.log(`${prefix}  ${subdir.name}/`);
    logDirectoryTree(path.join(dir, subdir.name), `${prefix}    `);
  }
  if (dirs.length > 10) {
    console.log(`${prefix}  ... and ${dirs.length - 10} more directories`);
  }
}

function verifyPreparedRuntime() {
  for (const requiredPath of [outputNodePath, outputNpmCliPath, outputNpxCliPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Prepared macOS Node runtime is missing ${requiredPath}`);
    }
  }
  if (process.platform !== "darwin") {
    return;
  }
  const version = execFileSync(outputNodePath, ["--version"], { encoding: "utf8" }).trim();
  if (!version.startsWith("v")) {
    throw new Error(`Packaged macOS Node runtime returned an invalid version: ${version}`);
  }
  const npmVersion = execFileSync(outputNodePath, [outputNpmCliPath, "--version"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+/.test(npmVersion)) {
    throw new Error(`Packaged macOS npm returned an invalid version: ${npmVersion}`);
  }
}
