import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const expectedUndiciVersion = "7.25.0";

function assertUndiciElectronCompatibility() {
  const undiciPackagePath = path.join(repoRoot, "node_modules", "undici", "package.json");
  if (!fs.existsSync(undiciPackagePath)) {
    return;
  }

  const version = JSON.parse(fs.readFileSync(undiciPackagePath, "utf8")).version;
  if (version === expectedUndiciVersion) {
    return;
  }

  throw new Error(
    `undici@${version} is installed, but Electron requires undici@${expectedUndiciVersion} ` +
      `(newer undici versions call worker_threads.markAsUncloneable, which Electron lacks). ` +
      "Reinstall dependencies with: pnpm install",
  );
}

function getPlatformPath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

async function extractElectronArchive(zipPath, distPath, electronPackageDir) {
  try {
    const electronRequire = createElectronRequire(electronPackageDir);
    const extract = electronRequire("extract-zip");
    await extract(zipPath, { dir: distPath });
    return;
  } catch (error) {
    if (process.platform === "win32") {
      throw error;
    }
    console.warn("extract-zip failed, falling back to unzip:", error instanceof Error ? error.message : error);
    execFileSync("unzip", ["-q", zipPath, "-d", distPath], { stdio: "inherit" });
  }
}

function createElectronRequire(electronPackageDir) {
  return createRequire(fs.realpathSync(path.join(electronPackageDir, "package.json")));
}

function resolveElectronPackageDir() {
  const candidateDirs = [
    path.join(desktopRoot, "node_modules", "electron"),
    path.join(repoRoot, "node_modules", "electron"),
  ];
  for (const candidateDir of candidateDirs) {
    if (fs.existsSync(path.join(candidateDir, "package.json"))) {
      return fs.realpathSync(candidateDir);
    }
  }

  const requireCandidates = [
    createRequire(path.join(desktopRoot, "package.json")),
    createRequire(path.join(repoRoot, "package.json")),
  ];
  for (const requireFrom of requireCandidates) {
    try {
      return path.dirname(fs.realpathSync(requireFrom.resolve("electron/package.json")));
    } catch {
      // Try the next workspace/root resolution base.
    }
  }

  return undefined;
}

function isElectronInstalled(electronDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
  const platformPath = getPlatformPath();
  const binaryPath = path.join(electronDir, "dist", platformPath);
  try {
    const installedVersion = fs.readFileSync(path.join(electronDir, "dist", "version"), "utf8").replace(/^v/, "").trim();
    const pathTxt = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    return installedVersion === pkg.version && pathTxt === platformPath && fs.existsSync(binaryPath);
  } catch {
    return false;
  }
}

async function main() {
  assertUndiciElectronCompatibility();

  const electronDir = resolveElectronPackageDir();
  if (!electronDir) {
    throw new Error("electron package is missing. Run pnpm install first.");
  }

  if (isElectronInstalled(electronDir)) {
    console.log("Electron binary already installed.");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
  const checksums = JSON.parse(fs.readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
  const platformPath = getPlatformPath();
  const distPath = path.join(electronDir, "dist");
  const { downloadArtifact } = createElectronRequire(electronDir)("@electron/get");

  console.log(`Installing Electron ${pkg.version} for ${process.platform}-${process.arch}...`);
  const zipPath = await downloadArtifact({
    version: pkg.version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums,
  });

  fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });
  await extractElectronArchive(zipPath, distPath, electronDir);
  await fs.promises.writeFile(path.join(electronDir, "path.txt"), platformPath);

  const binaryPath = path.join(distPath, platformPath);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Electron binary not found after install: ${binaryPath}`);
  }

  console.log(`Electron installed: ${binaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
