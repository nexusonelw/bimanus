#!/usr/bin/env node
// Local one-shot release orchestrator for pi-gui / bimanus.
//
// Builds installers 100% locally for:
//   - macOS arm64 (dmg + zip)
//   - macOS x64   (dmg + zip)
//   - Windows x64  (nsis .exe)        [cross-built via wine on macOS]
//   - Linux  x64  (AppImage)         [cross-built on macOS]
//
// Then tags the repo and uploads every artifact to a GitHub Release on the
// current `origin` remote (default: nexusonelw/bimanus).
//
// Versioning is automatic: it reads the latest `v*` git tag and increments
// the prerelease counter (e.g. v0.1.0-beta.28 -> v0.1.0-beta.29). Override with
// `--version 0.2.0` or switch to a stable tag with `--stable`.
//
// Usage:
//   pnpm release                       # build everything + publish
//   pnpm release --no-publish          # build only, do not upload
//   pnpm release --no-mac-x64 --no-win # skip targets
//   pnpm release --version 0.2.0       # explicit version
//   pnpm release --stable              # vX.Y.Z (no -beta suffix)
//   pnpm release --dry-run             # plan only, no build/tag/push
//
// Requires: node, pnpm, git, gh (authenticated), wine (for Windows cross-build).

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const releaseDir = path.join(desktopDir, "release");

const args = process.argv.slice(2);
const opts = parseArgs(args);

main().catch((err) => {
  console.error("\n✖ release-local failed:");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

async function main() {
  banner("pi-gui local release orchestrator");

  checkPrerequisites();

  const version = resolveVersion(opts);
  const tag = `v${version}`;
  log(`Target version: ${version}  (tag ${tag})`);

  const targets = resolveTargets(opts);
  log(`Targets: ${targets.join(", ")}`);

  if (opts.dryRun) {
    log("Dry-run mode: skipping build/tag/publish.");
    return;
  }

  // Clean previous artifacts so uploads don't include stale files.
  rmSync(releaseDir, { recursive: true, force: true });

  // Single source build (deps + notification helper + electron-vite).
  step("build", () =>
    run("pnpm", ["--filter", "@bimanus/desktop", "run", "build"], { cwd: repoRoot }),
  );

  const electronBuilderBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  );

  const commonVersionArgs = [`-c.extraMetadata.version=${version}`];
  // Disable Apple code signing / notarization for unsigned local builds.
  const macDisableSignArgs = [
    `-c.mac.notarize=false`,
    `-c.mac.identity=null`,
  ];

  // ---- macOS arm64 + x64 ----
  if (targets.includes("mac-arm64") || targets.includes("mac-x64")) {
    step("prepare macOS node runtime (arm64)", () =>
      run(
        "pnpm",
        ["--filter", "@bimanus/desktop", "run", "prepare:macos-node-runtime:arm64"],
        { cwd: repoRoot },
      ),
    );
    step("prepare macOS node runtime (x64)", () =>
      run(
        "pnpm",
        ["--filter", "@bimanus/desktop", "run", "prepare:macos-node-runtime:x64"],
        { cwd: repoRoot },
      ),
    );

    const macArchs = [];
    if (targets.includes("mac-arm64")) macArchs.push("arm64");
    if (targets.includes("mac-x64")) macArchs.push("x64");

    step(`electron-builder --mac dmg zip (${macArchs.join(",")})`, () =>
      execFileSync(
        electronBuilderBin,
        [
          "--mac",
          "dmg",
          "zip",
          ...macArchs.flatMap((a) => [`--${a}`]),
          "--publish",
          "never",
          ...commonVersionArgs,
          ...macDisableSignArgs,
        ],
        { cwd: desktopDir, stdio: "inherit" },
      ),
    );
  }

  // ---- Windows x64 (NSIS) ----
  // Reuse the repo's package-windows.mjs which handles bundled node-runtime
  // removal + runtime-deps verification for win32. We expose the version via
  // env so the inner electron-builder call picks it up.
  if (targets.includes("win-x64")) {
    step("package Windows x64 (NSIS)", () =>
      run("node", ["scripts/package-windows.mjs", "--arch=x64"], {
        cwd: desktopDir,
        env: {
          ...process.env,
          PI_RELEASE_VERSION: version,
          // wine is required for cross-building nsis on macOS.
          // package-windows.mjs calls electron-builder with --publish never.
        },
      }),
    );
    // package-windows.mjs does not apply extraMetadata; rename artifacts so
    // their filename reflects the release version.
    renameWinArtifactsToVersion(version);
  }

  // ---- Linux x64 (AppImage) ----
  if (targets.includes("linux-x64")) {
    step("electron-builder --linux AppImage (x64)", () =>
      execFileSync(
        electronBuilderBin,
        [
          "--linux",
          "AppImage",
          "--x64",
          "--publish",
          "never",
          ...commonVersionArgs,
        ],
        { cwd: desktopDir, stdio: "inherit" },
      ),
    );
  }

  // ---- Collect artifacts ----
  const artifacts = collectArtifacts();
  if (artifacts.length === 0) {
    throw new Error(`No artifacts found under ${releaseDir}`);
  }
  log(`Artifacts (${artifacts.length}):`);
  artifacts.forEach((f) => log(`  • ${path.basename(f)}`));

  if (opts.noPublish) {
    log("--no-publish set; skipping tag + GitHub release.");
    return;
  }

  // ---- Tag + push ----
  step(`create tag ${tag}`, () => {
    try {
      execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: "ignore" });
      log(`Tag ${tag} already exists locally; reusing it.`);
    } catch {
      execFileSync("git", ["tag", tag], { cwd: repoRoot, stdio: "inherit" });
    }
  });

  step(`push tag ${tag} to origin`, () =>
    execFileSync("git", ["push", "origin", tag], { cwd: repoRoot, stdio: "inherit" }),
  );

  // ---- GitHub release ----
  const remote = originRepo();
  log(`GitHub repo: ${remote.owner}/${remote.repo}`);

  const isPrerelease = /-(alpha|beta|rc)\./.test(version);
  const notes = generateNotes(version, artifacts);

  step(`gh release create ${tag}`, () => {
    const ghArgs = [
      "release",
      "create",
      tag,
      "--repo",
      `${remote.owner}/${remote.repo}`,
      "--title",
      tag,
      "--notes",
      notes,
    ];
    if (isPrerelease) ghArgs.push("--prerelease");
    ghArgs.push(...artifacts);
    execFileSync("gh", ghArgs, { cwd: repoRoot, stdio: "inherit" });
  });

  banner(`Done. Release ${tag} published to ${remote.owner}/${remote.repo}`);
  artifacts.forEach((f) => log(`  • ${path.basename(f)}`));
}

// ---------- helpers ----------

function parseArgs(argv) {
  const o = {
    version: null,
    stable: false,
    dryRun: false,
    noPublish: false,
    macArm64: true,
    macX64: true,
    winX64: true,
    linuxX64: true,
  };
  for (const a of argv) {
    switch (a) {
      case "--stable":
        o.stable = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--no-publish":
        o.noPublish = true;
        break;
      case "--no-mac-arm64":
        o.macArm64 = false;
        break;
      case "--no-mac-x64":
        o.macX64 = false;
        break;
      case "--no-win":
      case "--no-win-x64":
        o.winX64 = false;
        break;
      case "--no-linux":
      case "--no-linux-x64":
        o.linuxX64 = false;
        break;
      default:
        if (a.startsWith("--version=")) o.version = a.slice("--version=".length);
        else if (a === "--version") {
          /* expect next arg */
        } else throw new Error(`Unknown flag: ${a}`);
    }
  }
  return o;
}

function checkPrerequisites() {
  const tools = ["git", "pnpm", "gh"];
  if (process.platform !== "win32") tools.push("wine");
  for (const t of tools) {
    try {
      execSync(`command -v ${t} >/dev/null 2>&1`);
    } catch {
      throw new Error(`Missing required tool: ${t}`);
    }
  }
  // gh must be authenticated.
  try {
    execSync("gh auth status >/dev/null 2>&1");
  } catch {
    throw new Error("`gh` is not authenticated. Run: gh auth login");
  }
}

function resolveVersion(opts) {
  if (opts.version) return opts.version.replace(/^v/, "");

  let latest;
  try {
    latest = execSync("git tag --list 'v*' --sort=-v:refname", {
      cwd: repoRoot,
    })
      .toString()
      .split("\n")
      .filter(Boolean)[0];
  } catch {}
  latest = latest ? latest.replace(/^v/, "") : "0.1.0-beta.0";

  if (opts.stable) {
    // strip prerelease, bump patch
    const base = latest.replace(/-.*$/, "");
    const [maj, min, pat] = base.split(".").map(Number);
    return `${maj}.${min}.${pat + 1}`;
  }

  // Increment prerelease counter: X.Y.Z-beta.N -> X.Y.Z-beta.(N+1)
  const m = latest.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  if (m) return `${m[1]}-beta.${Number(m[2]) + 1}`;
  // Fallback: bump patch and start a new beta.
  const base = latest.replace(/-.*$/, "");
  const [maj, min, pat] = base.split(".").map(Number);
  return `${maj}.${min}.${pat + 1}-beta.1`;
}

function resolveTargets(opts) {
  const t = [];
  if (opts.macArm64) t.push("mac-arm64");
  if (opts.macX64) t.push("mac-x64");
  if (opts.winX64) t.push("win-x64");
  if (opts.linuxX64) t.push("linux-x64");
  return t;
}

function renameWinArtifactsToVersion(version) {
  // package-windows.mjs builds with the package.json version (0.1.0).
  // electron-builder uses artifactName = ${productName}-${version}-${arch}.${ext}
  // so .exe filenames carry 0.1.0. Rename to the release version for clarity.
  if (!existsSync(releaseDir)) return;
  for (const f of readdirSync(releaseDir)) {
    const m = f.match(/^(.*?-)\d+\.\d+\.\d+(?:-[^.]+)?(-x64\.exe)$/);
    if (m) {
      const from = path.join(releaseDir, f);
      const to = path.join(releaseDir, `${m[1]}${version}${m[2]}`);
      if (from !== to && existsSync(from)) {
        execSync(`mv "${from}" "${to}"`);
        log(`renamed ${f} -> ${path.basename(to)}`);
      }
    }
  }
}

function collectArtifacts() {
  if (!existsSync(releaseDir)) return [];
  const keep = [".dmg", ".zip", ".exe", ".AppImage", ".yml", ".yaml"];
  return readdirSync(releaseDir)
    .filter((f) => keep.some((e) => f.endsWith(e)))
    .filter((f) => !/^latest-/.test(f) || f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(releaseDir, f))
    .sort();
}

function originRepo() {
  let url;
  try {
    url = execSync("git remote get-url origin", { cwd: repoRoot }).toString().trim();
  } catch {
    throw new Error("No git remote named 'origin'.");
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^.\s]+)/);
  if (!m) throw new Error(`Cannot parse GitHub owner/repo from: ${url}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

function generateNotes(version, artifacts) {
  const lines = [
    `Bimanus ${version}`,
    "",
    "Local build artifacts. Unsigned (no Apple notarization).",
    "",
    "## Downloads",
    ...artifacts.map((f) => `- ${path.basename(f)}`),
    "",
    "## Platforms",
    "- macOS Apple Silicon (arm64): .dmg / .zip",
    "- macOS Intel (x64): .dmg / .zip",
    "- Windows x64: NSIS .exe",
    "- Linux x64: AppImage",
  ];
  return lines.join("\n");
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function step(name, fn) {
  console.log(`\n▶ ${name}`);
  fn();
}

function log(msg) {
  console.log(`  ${msg}`);
}

function banner(msg) {
  console.log("\n========================================");
  console.log(`  ${msg}`);
  console.log("========================================");
}