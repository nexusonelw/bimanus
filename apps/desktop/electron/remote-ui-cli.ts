/**
 * Lightweight CLI flag parser for remote UI configuration.
 *
 * Priority when applied to env: CLI flags override existing env values.
 * Supported flags:
 *   --remote-ui / --remote-ui=1|0|true|false
 *   --remote-ui-port <n> | --remote-ui-port=<n>
 *   --remote-ui-token <s> | --remote-ui-token=<s>
 *   --remote-ui-password <s> | --remote-ui-password=<s>  (alias of token)
 *   --remote-ui-host <s> | --remote-ui-host=<s>
 *   --headless / --headless=1|0|true|false
 *   --no-remote-ui
 */

export interface RemoteUiCliOptions {
  readonly enable?: boolean;
  readonly port?: number;
  readonly token?: string;
  readonly host?: string;
  readonly headless?: boolean;
}

function readValue(argv: readonly string[], index: number, flag: string): { value: string; nextIndex: number } | null {
  const current = argv[index];
  if (!current) {
    return null;
  }
  if (current.startsWith(`${flag}=`)) {
    return { value: current.slice(flag.length + 1), nextIndex: index };
  }
  if (current === flag) {
    const next = argv[index + 1];
    if (!next || next.startsWith("-")) {
      return null;
    }
    return { value: next, nextIndex: index + 1 };
  }
  return null;
}

function parseBooleanFlag(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return true;
}

export function parseRemoteUiCliArgs(argv: readonly string[]): RemoteUiCliOptions {
  let enable: boolean | undefined;
  let port: number | undefined;
  let token: string | undefined;
  let host: string | undefined;
  let headless: boolean | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      // Electron may insert a bare `--` before app args; keep scanning after it.
      continue;
    }

    if (arg === "--no-remote-ui") {
      enable = false;
      continue;
    }

    if (arg === "--headless") {
      headless = true;
      continue;
    }

    if (arg === "--no-headless") {
      headless = false;
      continue;
    }

    if (arg === "--remote-ui") {
      enable = true;
      continue;
    }

    const enableValue = readValue(argv, index, "--remote-ui");
    if (enableValue) {
      enable = parseBooleanFlag(enableValue.value);
      index = enableValue.nextIndex;
      continue;
    }

    const portValue = readValue(argv, index, "--remote-ui-port");
    if (portValue) {
      const numeric = Number(portValue.value);
      if (Number.isFinite(numeric)) {
        port = Math.round(numeric);
      }
      index = portValue.nextIndex;
      continue;
    }

    const tokenValue = readValue(argv, index, "--remote-ui-token") ?? readValue(argv, index, "--remote-ui-password");
    if (tokenValue) {
      token = tokenValue.value;
      index = tokenValue.nextIndex;
      continue;
    }

    const hostValue = readValue(argv, index, "--remote-ui-host");
    if (hostValue) {
      host = hostValue.value.trim();
      index = hostValue.nextIndex;
      continue;
    }

    const headlessValue = readValue(argv, index, "--headless");
    if (headlessValue) {
      headless = parseBooleanFlag(headlessValue.value);
      index = headlessValue.nextIndex;
    }
  }

  return {
    ...(enable === undefined ? {} : { enable }),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(host === undefined ? {} : { host }),
    ...(headless === undefined ? {} : { headless }),
  };
}

/**
 * Apply CLI remote-UI options onto an env map.
 * CLI values always win over existing env entries.
 * Providing a token/port/host without an explicit enable flag still forces PI_APP_REMOTE_UI=1.
 */
export function applyRemoteUiCliArgsToEnv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RemoteUiCliOptions {
  const options = parseRemoteUiCliArgs(argv);

  if (options.enable === false) {
    env.PI_APP_REMOTE_UI = "0";
  } else if (options.enable === true || options.token || options.port !== undefined || options.host) {
    env.PI_APP_REMOTE_UI = "1";
  }

  if (options.port !== undefined) {
    env.PI_APP_REMOTE_UI_PORT = String(options.port);
  }
  if (options.token !== undefined) {
    env.PI_APP_REMOTE_UI_TOKEN = options.token;
  }
  if (options.host !== undefined) {
    env.PI_APP_REMOTE_UI_HOST = options.host;
  }
  if (options.headless === true) {
    env.PI_APP_HEADLESS = "1";
    // Headless server mode only makes sense with the existing remote UI bridge.
    if (env.PI_APP_REMOTE_UI !== "0") {
      env.PI_APP_REMOTE_UI = "1";
    }
  } else if (options.headless === false) {
    env.PI_APP_HEADLESS = "0";
  }

  return options;
}

export function isHeadlessMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.PI_APP_HEADLESS?.trim().toLowerCase();
  if (configured === "1" || configured === "true" || configured === "yes" || configured === "on") {
    return true;
  }
  if (configured === "0" || configured === "false" || configured === "no" || configured === "off") {
    return false;
  }
  return false;
}
