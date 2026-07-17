/**
 * CLI enablement catalog and pure helpers.
 *
 * Keeps supported CLI keys, default-on enablement, merge/normalize rules, and
 * display metadata outside of app-store / UI so persistence and filters stay consistent.
 */

/** Supported coding CLI types used by split panel + remote agent. */
export const KNOWN_CLI_TYPES = [
  "codex",
  "claude",
  "opencode",
  "grok",
  "copilot",
  "antigravity",
  "kiro",
  "cursor",
  "droid",
] as const;

export type KnownCliType = (typeof KNOWN_CLI_TYPES)[number];

export type CliEnablementMap = Readonly<Record<string, boolean>>;

export interface CliCatalogEntry {
  readonly type: KnownCliType;
  readonly label: string;
  readonly description: string;
}

/** Static display catalog for settings and dropdown labels. */
export const CLI_CATALOG: readonly CliCatalogEntry[] = [
  { type: "codex", label: "CodeX", description: "CodeX CLI" },
  { type: "claude", label: "Claude Code", description: "Claude Code CLI" },
  { type: "opencode", label: "OpenCode", description: "OpenCode CLI" },
  { type: "grok", label: "Grok", description: "Grok CLI" },
  { type: "copilot", label: "Copilot", description: "Copilot CLI" },
  { type: "antigravity", label: "Antigravity", description: "Antigravity CLI" },
  { type: "kiro", label: "Kiro", description: "Kiro CLI" },
  { type: "cursor", label: "Cursor", description: "Cursor CLI" },
  { type: "droid", label: "Droid", description: "Droid CLI" },
] as const;

/** Default: every known CLI is enabled. */
export function createDefaultCliEnablement(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const cliType of KNOWN_CLI_TYPES) {
    map[cliType] = true;
  }
  return map;
}

/**
 * Merge persisted enablement with current known CLI set.
 * Missing keys default to enabled; unknown keys are kept for forward compatibility.
 */
export function mergeCliEnablement(persisted?: CliEnablementMap | null): Record<string, boolean> {
  const merged = createDefaultCliEnablement();
  if (!persisted || typeof persisted !== "object") {
    return merged;
  }

  for (const [key, value] of Object.entries(persisted)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    if (typeof value === "boolean") {
      merged[key] = value;
    }
  }
  return merged;
}

/** Treat missing keys as enabled so new CLIs stay visible by default. */
export function isCliEnabled(enablement: CliEnablementMap | undefined, cliType: string): boolean {
  if (!enablement) {
    return true;
  }
  return enablement[cliType] !== false;
}

export function cliDisplayName(cliType: string): string {
  const entry = CLI_CATALOG.find((item) => item.type === cliType);
  return entry?.label ?? cliType;
}

/** Error message returned to remote AI callers for disabled / missing CLIs. */
export function cliNotInstalledRemoteError(cliType: string): string {
  const name = cliDisplayName(cliType);
  return `CLI "${name}" is not installed in the system`;
}

export function isKnownCliType(value: string): value is KnownCliType {
  return (KNOWN_CLI_TYPES as readonly string[]).includes(value);
}
