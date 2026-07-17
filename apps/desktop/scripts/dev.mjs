import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const desktopRequire = createRequire(path.join(desktopDir, "package.json"));
const rawArgs = process.argv.slice(2);
const extraArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

// pnpm uses package filters to identify workspace packages
const packageFilters = ["@bimanus/session-driver", "@bimanus/pi-sdk-driver", "@bimanus/catalogs"];

// Bun handles these manually by directory
const packagePaths = [
  path.resolve(repoRoot, "packages/session-driver"),
  path.resolve(repoRoot, "packages/pi-sdk-driver"),
  path.resolve(repoRoot, "packages/catalogs"),
];

const isBun = process.versions.bun || process.env.npm_config_user_agent?.includes("bun");

async function run(cmd, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${cmd} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

function start(cmd, args, cwd) {
  return spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

async function main() {
  await run("node", [path.resolve(repoRoot, "scripts/ensure-electron-binary.mjs")], repoRoot);

  if (isBun) {
    for (const pkgPath of packagePaths) {
      await run("bun", ["run", "build"], pkgPath);
    }
  } else {
    await run(
      "pnpm",
      ["--dir", repoRoot, "--filter", packageFilters[0], "--filter", packageFilters[1], "--filter", packageFilters[2], "run", "build"],
      desktopDir,
    );
  }

  // Step 3: One-shot production build (no watch, no HMR)
  console.log("\nBuilding main + preload + renderer...");
  if (isBun) {
    await run("bun", ["x", "electron-vite", "build", ...extraArgs], desktopDir);
  } else {
    await run("pnpm", ["exec", "electron-vite", "build", ...extraArgs], desktopDir);
  }

  // Step 4: Launch Electron directly (no HMR, no auto-reload)
  console.log("\nStarting Electron...");
  // Resolve the local electron binary (works with both pnpm hoisted and bun layouts)
  const electronCli = desktopRequire.resolve("electron/cli.js");
  const electron = start(
    process.execPath,
    [electronCli, desktopDir],
    desktopDir,
  );

  electron.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  electron.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });

  process.once("SIGINT", () => {
    if (!electron.killed) {
      electron.kill("SIGTERM");
    }
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    if (!electron.killed) {
      electron.kill("SIGTERM");
    }
    process.exit(143);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});