import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const pathsProject = path.resolve(projectRoot, "tsconfig.paths.json");
const devPort = Number(process.env.PI_APP_DEV_PORT ?? "43173");
const remoteUiEnabled = process.env.PI_APP_REMOTE_UI?.trim() === "1";
const remoteUiHost = process.env.PI_APP_REMOTE_UI_HOST?.trim();
const remoteUiPort = Number(process.env.PI_APP_REMOTE_UI_PORT ?? "43174");
const devHost = process.env.PI_APP_DEV_HOST?.trim() || remoteUiHost;

function resolveRemoteUiProxyTarget() {
  const targetHost = remoteUiHost === "0.0.0.0" ? "127.0.0.1" : (remoteUiHost || "127.0.0.1");
  return `http://${targetHost}:${remoteUiPort}`;
}

export default defineConfig(({ command }) => {
  const cleanOutputs = command === "build";
  const rendererServer = {
    port: devPort,
    strictPort: true,
    ...(devHost ? { host: devHost } : {}),
    ...(remoteUiEnabled
      ? {
          // Keep the renderer on Vite in dev while forwarding the remote bridge
          // to the existing Electron main-process HTTP/SSE server.
          proxy: {
            "/api": {
              target: resolveRemoteUiProxyTarget(),
              changeOrigin: false,
            },
          },
        }
      : {}),
  };

  return {
    main: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      build: {
        outDir: "out/main",
        emptyOutDir: cleanOutputs,
        // Bundle our own ESM-only workspace packages into main.js instead of
        // leaving them as runtime `require("@bimanus/...")` calls: those packages
        // ship ESM (or raw TS) output, which Electron's CJS main process cannot
        // `require()` at runtime (SyntaxError: Unexpected token 'export').
        externalizeDeps: {
          // These ship ESM-only ("type": "module", no "require" export condition),
          // so Electron's CJS main process cannot `require()` them at runtime.
          // Bundling them via Rollup avoids the CJS/ESM interop crash entirely.
          exclude: [
            "@bimanus/pi-sdk-driver",
            "@bimanus/cli-adapter",
            "@earendil-works/pi-coding-agent",
          ],
        },
        rollupOptions: {
          input: {
            main: path.resolve(projectRoot, "electron/main.ts"),
          },
        },
      },
    },
    preload: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      build: {
        outDir: "out/preload",
        emptyOutDir: cleanOutputs,
        rollupOptions: {
          input: {
            preload: path.resolve(projectRoot, "electron/preload.ts"),
          },
        },
      },
    },
    renderer: {
      root: projectRoot,
      base: "./",
      plugins: [react(), tsconfigPaths({ projects: [pathsProject] })],
      server: rendererServer,
      build: {
        outDir: "out/renderer",
        emptyOutDir: true,
        rollupOptions: {
          input: path.resolve(projectRoot, "index.html"),
        },
      },
    },
  };
});
