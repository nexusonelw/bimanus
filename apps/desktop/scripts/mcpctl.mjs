#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

function resolveUserDataDir() {
  const override = process.env.PI_APP_USER_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Bimanus");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Bimanus");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Bimanus");
}

function usage() {
  console.error("Usage: node apps/desktop/scripts/mcpctl.mjs <list|enable|disable> [name-or-id]");
  process.exitCode = 1;
}

async function readState(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resolveServer(servers, ref) {
  const trimmed = ref.trim();
  const exactId = servers.find((server) => server.id === trimmed);
  if (exactId) {
    return exactId;
  }
  const exactName = servers.find((server) => server.name === trimmed);
  if (exactName) {
    return exactName;
  }
  const matches = servers.filter((server) => server.id.startsWith(trimmed) || server.name.startsWith(trimmed));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous MCP server reference: ${trimmed}`);
  }
  throw new Error(`Unknown MCP server: ${trimmed}`);
}

const [, , command, ref] = process.argv;
const userDataDir = resolveUserDataDir();
const statePath = path.join(userDataDir, "ui-state.json");
const state = await readState(statePath);
const servers = Array.isArray(state.mcpServers) ? state.mcpServers : [];

if (command === "list") {
  if (servers.length === 0) {
    console.log("No MCP servers configured.");
    process.exit(0);
  }
  for (const server of servers) {
    console.log(`${server.id}\t${server.name}\t${server.enabled === false ? "disabled" : "enabled"}\t${server.url}`);
  }
  process.exit(0);
}

if ((command === "enable" || command === "disable") && ref) {
  const server = resolveServer(servers, ref);
  server.enabled = command === "enable";
  server.updatedAt = new Date().toISOString();
  state.mcpServers = servers;
  await writeState(statePath, state);
  console.log(`${command}d ${server.name}`);
  console.log("If Bimanus is already running, use /mcp:reload in the active thread to refresh session tools.");
  process.exit(0);
}

usage();
