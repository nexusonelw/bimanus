import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");

/**
 * electron-builder's extraResources copy filter hard-codes exclusion of a root
 * `node_modules` directory (see app-builder-lib createFilter). That strips the
 * bundled npm installation from macOS node-runtime resources and causes package
 * installs to fall back to spawning bare `npm`, which fails with ENOENT when the
 * app is launched from Finder/GUI with a minimal PATH.
 *
 * Preferred layout (survives packaging):
 *   node-runtime/lib/node_modules/npm/...
 * Legacy layout (source/build cache only):
 *   node-runtime/node_modules/npm/...
 *
 * This hook is also safe to run as a CLI against apps/desktop/release/.
 */
export default async function afterPack(context) {
  if (context?.electronPlatformName && context.electronPlatformName !== "darwin") {
    return;
  }

  if (context?.appOutDir) {
    const arch = normalizeArch(context.arch);
    const appBundleDir = findAppBundle(context.appOutDir);
    if (!appBundleDir) {
      console.warn(`[inject-macos-npm-runtime] No .app bundle under ${context.appOutDir}`);
      return;
    }
    injectIntoAppBundle(appBundleDir, arch);
    return;
  }

  injectIntoReleaseDirectory();
}

function injectIntoReleaseDirectory() {
  const releaseDir = path.join(desktopDir, "release");
  if (!existsSync(releaseDir)) {
    console.log("No release/ directory found, skipping npm injection.");
    return;
  }

  let injectedAny = false;
  for (const arch of ["x64", "arm64"]) {
    for (const appBundleDir of findMatchingAppBundles(releaseDir, arch)) {
      if (injectIntoAppBundle(appBundleDir, arch)) {
        injectedAny = true;
      }
    }
  }

  if (!injectedAny) {
    console.log("No npm modules injected into any macOS .app bundle.");
  }
}

function injectIntoAppBundle(appBundleDir, arch) {
  const targetRuntimeDir = path.join(appBundleDir, "Contents", "Resources", "node-runtime");
  if (!existsSync(targetRuntimeDir)) {
    console.warn(`[inject-macos-npm-runtime] Missing node-runtime in ${appBundleDir}`);
    return false;
  }

  const targetNpmCliPath = resolveNpmCliPath(targetRuntimeDir);
  if (targetNpmCliPath) {
    console.log(`✓ bundled npm already present at ${targetNpmCliPath}`);
    return false;
  }

  const sourceRuntimeDir = path.join(desktopDir, "build", "native", "node-runtime", "darwin", arch);
  const sourceNpmRoot = resolveNpmPackageRoot(sourceRuntimeDir);
  if (!sourceNpmRoot) {
    throw new Error(
      `Cannot inject bundled npm into ${appBundleDir}: source runtime missing npm package under ${sourceRuntimeDir}`,
    );
  }

  const targetNpmRoot = path.join(targetRuntimeDir, "lib", "node_modules", "npm");
  mkdirSync(path.dirname(targetNpmRoot), { recursive: true });
  rmSync(targetNpmRoot, { recursive: true, force: true });
  console.log(`Injecting bundled npm from ${sourceNpmRoot} into ${targetNpmRoot}...`);
  cpSync(sourceNpmRoot, targetNpmRoot, { recursive: true });

  const injectedCli = resolveNpmCliPath(targetRuntimeDir);
  if (!injectedCli) {
    throw new Error(`Failed to inject npm-cli.js into ${targetRuntimeDir}`);
  }
  console.log(`✓ npm-cli.js injected at ${injectedCli}`);
  return true;
}

function resolveNpmPackageRoot(runtimeDir) {
  const candidates = [
    path.join(runtimeDir, "lib", "node_modules", "npm"),
    path.join(runtimeDir, "node_modules", "npm"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "bin", "npm-cli.js")));
}

function resolveNpmCliPath(runtimeDir) {
  const candidates = [
    path.join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function findAppBundle(appOutDir) {
  if (!existsSync(appOutDir)) {
    return undefined;
  }
  if (appOutDir.endsWith(".app")) {
    return appOutDir;
  }
  const entries = readdirSync(appOutDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      return path.join(appOutDir, entry.name);
    }
  }
  return undefined;
}

function findMatchingAppBundles(releaseDir, arch) {
  const entries = readdirSync(releaseDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const outerDir = path.join(releaseDir, entry.name);
    const dirName = entry.name.toLowerCase();
    const archPattern = arch === "x64" ? /darwin-x64|-x64-unpacked$|^mac-x64|^mac$/ : /darwin-arm64|-arm64-unpacked$|^mac-arm64/;
    if (!archPattern.test(dirName)) continue;

    const appBundle = findAppBundle(outerDir);
    if (appBundle) {
      results.push(appBundle);
    }
  }

  return results;
}

function normalizeArch(arch) {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
  if (arch === 1 || arch === "x64" || arch === "amd64") return "x64";
  if (arch === 3 || arch === "arm64" || arch === "aarch64") return "arm64";
  if (typeof arch === "string") {
    if (arch.includes("arm64") || arch.includes("aarch64")) return "arm64";
    if (arch.includes("x64") || arch.includes("amd64")) return "x64";
  }
  throw new Error(`Unsupported macOS packaging architecture for npm injection: ${String(arch)}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await afterPack();
}
