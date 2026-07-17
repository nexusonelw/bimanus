import { createHash } from "node:crypto";

function sanitizeSegment(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "tool";
}

export function piToolName(serverName: string, serverId: string, toolName: string): string {
  const serverSegment = sanitizeSegment(serverName);
  const toolSegment = sanitizeSegment(toolName);
  const idSegment = serverId.replace(/-/g, "").slice(0, 8) || "server";
  const raw = `mcp_${serverSegment}_${toolSegment}_${idSegment}`;
  if (raw.length <= 64) {
    return raw;
  }
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}
