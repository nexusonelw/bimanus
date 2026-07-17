import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "tar";

const require = createRequire(import.meta.url);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const electronBuilderBin = path.join(
  repoDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

const args = process.argv.slice(2);
const dirOnly = args.includes("--dir");
const archFlag = args.find((arg) => arg.startsWith("--arch=")) ?? "--arch=x64";
const arch = archFlag.slice("--arch=".length);
const archSuffix = arch === "arm64" ? "arm64" : "x64";

run();

async function run() {
  step("build", () => execSync("pnpm run build", { cwd: desktopDir, stdio: "inherit" }));

  await step("ensure cross-platform ripgrep binary", () => ensureRipgrepBinary(archSuffix));

  const dirArgs = ["--win", "nsis", `--${arch}`, "--dir", "--publish", "never"];
  step("electron-builder --dir", () =>
    execFileSync(electronBuilderBin, dirArgs, { cwd: desktopDir, stdio: "inherit" }),
  );

  const unpackedDir = findUnpackedDir();
  if (unpackedDir) {
    step("remove-bundled-node-runtime", () => removeBundledNodeRuntime(unpackedDir));
    step("verify-packaged-runtime-deps", () =>
      execFileSync(process.execPath, ["scripts/assert-packaged-runtime-deps.mjs"], {
        cwd: desktopDir,
        env: {
          ...process.env,
          PI_APP_PACKAGE_PLATFORM: "win32",
          PI_APP_PACKAGE_ARCH: archSuffix,
        },
        stdio: "inherit",
      }),
    );
  } else {
    console.log("No unpacked directory found, skipping packaged runtime verification.");
  }

  if (!dirOnly && unpackedDir) {
    step("electron-builder --prepackaged", () =>
      execFileSync(electronBuilderBin, [
        "--win", "nsis", `--${arch}`,
        "--prepackaged", unpackedDir,
        "--publish", "never",
      ], { cwd: desktopDir, stdio: "inherit" }),
    );
  }
}

function step(name, fn) {
  console.log(`\n=== ${name} ===`);
  return fn();
}

function removeBundledNodeRuntime(unpackedDir) {
  const nodeRuntimeDir = path.join(unpackedDir, "resources", "node-runtime");
  if (!existsSync(nodeRuntimeDir)) {
    return;
  }
  rmSync(nodeRuntimeDir, { recursive: true, force: true });
  console.log(`Removed bundled Node/npm runtime: ${nodeRuntimeDir}`);
}

function findUnpackedDir() {
  const releaseDir = path.join(desktopDir, "release");
  if (!existsSync(releaseDir)) {
    return undefined;
  }
  const preferredName = archSuffix === "arm64" ? "win-arm64-unpacked" : "win-unpacked";
  const preferredDir = path.join(releaseDir, preferredName);
  if (existsSync(preferredDir)) {
    return preferredDir;
  }
  const entries = readdirSync(releaseDir, { withFileTypes: true });
  const unpacked = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-unpacked"))
    .sort()
    .map((entry) => path.join(releaseDir, entry.name));
  return unpacked[0];
}

// Cross-built Windows apps need the win32 ripgrep binary package present under
// node_modules/@vscode so electron-builder's `asarUnpack` copies `rg.exe` into
// `app.asar.unpacked`. pnpm's hoisted linker does not install cross-platform
// optionalDependencies automatically, so we fetch + stage the package here.
function ensureRipgrepBinary(arch) {
  const platformPkg = `@vscode/ripgrep-win32-${arch}`;
  // platformPkg is scoped (`@vscode/ripgrep-win32-x64`); join each segment so we
  // stage at node_modules/@vscode/ripgrep-win32-x64, not the nested
  // node_modules/@vscode/@vscode/ripgrep-win32-x64 path path.join would create
  // if given the full scoped name as a single segment after "@vscode".
  const destDir = path.join(repoDir, "node_modules", ...platformPkg.split("/"));
  const binFile = path.join(destDir, "bin", "rg.exe");
  const legacyNestedDir = path.join(repoDir, "node_modules", "@vscode", platformPkg);
  if (existsSync(legacyNestedDir) && path.resolve(legacyNestedDir) !== path.resolve(destDir)) {
    console.log(`Removing mis-staged ripgrep path: ${legacyNestedDir}`);
    rmSync(legacyNestedDir, { recursive: true, force: true });
  }
  if (existsSync(binFile)) {
    console.log(`ripgrep win32-${arch} binary already present: ${binFile}`);
    return Promise.resolve();
  }
  const ripgrepPkg = JSON.parse(
    execSync(
      `node -e "console.log(JSON.stringify(require('${path.join(repoDir, "node_modules", "@vscode", "ripgrep", "package.json")}')))"`,
    ).toString(),
  );
  const version = ripgrepPkg.version;
  const tarballUrl = resolveTarballUrl(platformPkg, version);
  const cacheDir = path.join(desktopDir, "build", "cache", "cross-deps");
  mkdirSync(cacheDir, { recursive: true });
  const tarballPath = path.join(cacheDir, `${platformPkg.replace("/", "-")}-${version}.tgz`);
  return (async () => {
    if (!existsSync(tarballPath)) {
      console.log(`Downloading ${platformPkg}@${version} ...`);
      await downloadFile(tarballUrl, tarballPath);
    }
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    console.log(`Extracting ${platformPkg} -> ${destDir}`);
    extract({ file: tarballPath, cwd: destDir, strip: 1, sync: true });
    if (!existsSync(binFile)) {
      throw new Error(`ripgrep binary not found after extract: ${binFile}`);
    }
    console.log(`Staged ${binFile}`);
  })();
}

function downloadFile(url, dest) {
  const https = require("node:https");
  const fs = require("node:fs");
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (r) => r.pipe(file).on("finish", resolve));
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        res.pipe(file).on("finish", resolve);
      } else {
        reject(new Error(`Download failed (${res.statusCode}): ${url}`));
      }
    }).on("error", reject);
  });
}

function resolveTarballUrl(pkg, version) {
  const scope = pkg.replace(/^(@[^/]+)\/.*/, "$1");
  const name = pkg.split("/")[1];
  return `https://registry.npmjs.org/${scope}/${name}/-/${name}-${version}.tgz`;
}
