import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { McpServerConfig } from "../src/desktop-state";
import type { McpServerOAuthTokens } from "./app-store-persistence";

interface OAuthProtectedResourceMetadata {
  readonly authorization_servers?: readonly string[];
  readonly issuer?: string;
}

interface OAuthAuthorizationServerMetadata {
  readonly issuer?: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly registration_endpoint?: string;
}

interface DynamicClientRegistrationResponse {
  readonly client_id?: string;
}

interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string;
}

interface OAuthCallbackServer {
  readonly redirectUri: string;
  readonly waitForCallback: Promise<OAuthCallbackResult>;
  readonly close: () => Promise<void>;
}

export interface McpOAuthManagerOptions {
  readonly openExternal: (url: string) => Promise<void>;
  readonly callbackTimeoutMs?: number;
}

const defaultCallbackTimeoutMs = 5 * 60_000;
const callbackPath = "/mcp/oauth/callback";

export class McpOAuthManager {
  constructor(private readonly options: McpOAuthManagerOptions) {}

  async authorize(server: McpServerConfig): Promise<McpServerOAuthTokens> {
    if (!server.oauthEnabled) {
      throw new Error(`${server.name} does not have OAuth enabled.`);
    }

    const resourceUrl = new URL(server.url);
    if (resourceUrl.protocol !== "http:" && resourceUrl.protocol !== "https:") {
      throw new Error("MCP OAuth only supports HTTP and HTTPS servers.");
    }

    const callbackServer = await startOAuthCallbackServer(this.options.callbackTimeoutMs ?? defaultCallbackTimeoutMs);
    try {
      const metadata = await discoverAuthorizationServerMetadata(resourceUrl);
      if (!metadata.authorization_endpoint) {
        throw new Error(`Unable to discover OAuth authorization endpoint for ${server.name}.`);
      }
      if (!metadata.token_endpoint) {
        throw new Error(`Unable to discover OAuth token endpoint for ${server.name}.`);
      }

      const clientId = await resolveOAuthClientId(metadata, callbackServer.redirectUri);
      const verifier = base64Url(randomBytes(32));
      const state = base64Url(randomBytes(24));
      const challenge = base64Url(createHash("sha256").update(verifier).digest());
      const authorizationUrl = new URL(metadata.authorization_endpoint);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      authorizationUrl.searchParams.set("resource", server.url);

      await this.options.openExternal(authorizationUrl.toString());
      const callback = await callbackServer.waitForCallback;
      if (callback.state !== state) {
        throw new Error("OAuth state did not match the authorization request.");
      }

      return exchangeAuthorizationCode({
        code: callback.code,
        clientId,
        redirectUri: callbackServer.redirectUri,
        resource: server.url,
        tokenEndpoint: metadata.token_endpoint,
        verifier,
      });
    } finally {
      await callbackServer.close();
    }
  }
}

async function discoverAuthorizationServerMetadata(resourceUrl: URL): Promise<OAuthAuthorizationServerMetadata> {
  const protectedResource = await fetchJson<OAuthProtectedResourceMetadata>(
    new URL("/.well-known/oauth-protected-resource", resourceUrl.origin).toString(),
  ).catch(() => undefined);
  const issuer = protectedResource?.authorization_servers?.[0] ?? protectedResource?.issuer;
  const candidateUrls = issuer
    ? authorizationMetadataUrls(new URL(issuer))
    : [new URL("/.well-known/oauth-authorization-server", resourceUrl.origin).toString()];

  for (const url of candidateUrls) {
    const metadata = await fetchJson<OAuthAuthorizationServerMetadata>(url).catch(() => undefined);
    if (metadata?.authorization_endpoint || metadata?.token_endpoint) {
      return metadata;
    }
  }

  return {};
}

function authorizationMetadataUrls(issuer: URL): readonly string[] {
  const originRoot = new URL("/.well-known/oauth-authorization-server", issuer.origin);
  if (issuer.pathname === "/" || issuer.pathname === "") {
    return [originRoot.toString()];
  }

  const pathScoped = new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin);
  return [pathScoped.toString(), originRoot.toString()];
}

async function resolveOAuthClientId(
  metadata: OAuthAuthorizationServerMetadata,
  redirectUri: string,
): Promise<string> {
  if (!metadata.registration_endpoint) {
    return "bimanus-desktop";
  }

  const response = await fetchJson<DynamicClientRegistrationResponse>(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      application_type: "native",
      client_name: "Bimanus desktop",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.client_id) {
    throw new Error("OAuth dynamic client registration did not return a client_id.");
  }
  return response.client_id;
}

async function exchangeAuthorizationCode({
  clientId,
  code,
  redirectUri,
  resource,
  tokenEndpoint,
  verifier,
}: {
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
  readonly verifier: string;
}): Promise<McpServerOAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    resource,
  });
  const response = await fetchJson<Record<string, unknown>>(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (typeof response.access_token !== "string" || response.access_token.length === 0) {
    throw new Error("OAuth token response did not include an access_token.");
  }

  const expiresIn = typeof response.expires_in === "number" ? response.expires_in : undefined;
  return {
    accessToken: response.access_token,
    ...(typeof response.refresh_token === "string" ? { refreshToken: response.refresh_token } : {}),
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    ...(typeof response.token_type === "string" ? { tokenType: response.token_type } : {}),
    ...(typeof response.scope === "string" ? { scope: response.scope } : {}),
  };
}

async function startOAuthCallbackServer(timeoutMs: number): Promise<OAuthCallbackServer> {
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let resolveCallback!: (result: OAuthCallbackResult) => void;
  let rejectCallback!: (error: Error) => void;
  const waitForCallback = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const settleError = (error: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    rejectCallback(error);
  };

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (error) {
      settleError(new Error(`OAuth authorization failed: ${error}`));
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(renderCallbackHtml("Authorization failed", "You can close this window and return to Bimanus."));
      return;
    }
    if (!code || !state) {
      settleError(new Error("OAuth callback did not include both code and state."));
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(renderCallbackHtml("Authorization failed", "The callback was missing required parameters."));
      return;
    }

    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    resolveCallback({ code, state });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderCallbackHtml("Authorization complete", "You can close this window and return to Bimanus."));
  });

  const redirectUri = await listenOnEphemeralPort(server);
  timeout = setTimeout(() => {
    settleError(new Error("OAuth authorization timed out."));
  }, timeoutMs);

  return {
    redirectUri,
    waitForCallback,
    close: () => closeServer(server),
  };
}

function listenOnEphemeralPort(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}${callbackPath}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json() as Promise<T>;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function renderCallbackHtml(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
