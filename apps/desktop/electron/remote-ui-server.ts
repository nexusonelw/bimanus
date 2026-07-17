import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const maxJsonBodyBytes = 32 * 1024 * 1024;
const executionDisconnectGraceMs = 30_000;
const completedExecutionRetentionMs = 60_000;

export interface RemoteUiClient {
  readonly id: string;
}

export interface RemoteUiInvokeRequest {
  readonly client: RemoteUiClient;
  readonly channel: string;
  readonly args: readonly unknown[];
}

export interface RemoteAgentInvokeRequest {
  readonly clientId: string;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly codingAgent?: RemoteCodingAgent;
  readonly sessionId?: string;
  readonly newSession?: boolean;
  readonly timeoutMs?: number;
  readonly closeOnComplete?: boolean;
  readonly signal?: AbortSignal;
}

export type RemoteCodingAgent =
  | "pi-coding-agent"
  | "codex"
  | "claude-code"
  | "opencode"
  | "grok"
  | "copilot"
  | "antigravity"
  | "kiro"
  | "cursor"
  | "droid";

export interface RemoteUiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly getToken: () => string;
  readonly rendererRoot: string;
  readonly invoke: (request: RemoteUiInvokeRequest) => Promise<unknown>;
  readonly invokeRemoteAgent?: (request: RemoteAgentInvokeRequest) => Promise<unknown>;
  readonly onClientConnected?: (client: RemoteUiClient) => void;
  readonly onClientDisconnected?: (client: RemoteUiClient) => void;
  readonly onExecutionConnected?: (client: RemoteUiClient) => void;
  readonly onExecutionDisconnected?: (client: RemoteUiClient) => void;
}

export interface RemoteUiServerStartResult {
  readonly port: number;
  readonly url: string;
}

interface RemoteUiConnection {
  readonly clientId: string;
  readonly response: ServerResponse;
}

interface ActiveExecutionTask {
  readonly promise: Promise<unknown>;
  readonly abort?: () => void;
  readonly client?: RemoteUiClient;
  response?: ServerResponse;
  disconnectTimer?: NodeJS.Timeout;
}

export class RemoteUiServer {
  private readonly server: Server;
  private readonly connections = new Map<string, Set<RemoteUiConnection>>();
  private readonly activeAgentTasks = new Map<string, ActiveExecutionTask>();
  private readonly activeInvokeTasks = new Map<string, ActiveExecutionTask>();

  constructor(private readonly options: RemoteUiServerOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const statusCode =
          error instanceof Error && error.name === "UnauthorizedRemoteUiRequest" ? 401 : 500;
        this.sendJson(response, statusCode, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  start(): Promise<RemoteUiServerStartResult> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const hostForUrl = this.options.host === "0.0.0.0" ? "localhost" : this.options.host;
        const port = resolveListeningPort(this.server.address(), this.options.port);
        resolve({
          port,
          url: `http://${hostForUrl}:${port}/`,
        });
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.host);
    });
  }

  close(): Promise<void> {
    for (const entries of this.connections.values()) {
      for (const connection of entries) {
        connection.response.end();
      }
    }
    this.connections.clear();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  publish(eventName: string, payload: unknown, clientId?: string): void {
    const targets = clientId ? [this.connections.get(clientId)] : [...this.connections.values()];
    for (const entries of targets) {
      if (!entries) {
        continue;
      }
      for (const connection of entries) {
        writeSseEvent(connection.response, eventName, payload);
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      this.writeCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/api/health") {
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/events") {
      this.requireAuthorized(request, url);
      this.handleEvents(url, response);
      return;
    }

    if (url.pathname === "/api/invoke") {
      this.requireAuthorized(request, url);
      await this.handleInvoke(request, response);
      return;
    }

    if (url.pathname === "/api/remote-agent/health") {
      this.requireAuthorized(request, url);
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/remote-agent") {
      this.requireAuthorized(request, url);
      await this.handleRemoteAgent(request, response);
      return;
    }

    await this.serveRendererAsset(url, response);
  }

  private handleEvents(url: URL, response: ServerResponse): void {
    const clientId = normalizeClientId(url.searchParams.get("clientId"));
    this.writeCorsHeaders(response);
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    // Disable Nagle's algorithm on the underlying socket so that small PTY
    // echo events (a few bytes per keystroke) are pushed to the mobile client
    // immediately instead of being coalesced into a larger TCP segment.
    const socket = response.socket;
    if (socket && typeof socket.setNoDelay === "function") {
      socket.setNoDelay(true);
    }
    response.write(`: Bimanus remote ui connected\n\n`);

    const connection: RemoteUiConnection = { clientId, response };
    const entries = this.connections.get(clientId) ?? new Set<RemoteUiConnection>();
    entries.add(connection);
    this.connections.set(clientId, entries);
    this.options.onClientConnected?.({ id: clientId });

    const heartbeat = setInterval(() => {
      response.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);

    response.on("close", () => {
      clearInterval(heartbeat);
      const current = this.connections.get(clientId);
      current?.delete(connection);
      if (!current || current.size === 0) {
        this.connections.delete(clientId);
        this.options.onClientDisconnected?.({ id: clientId });
      }
    });
  }

  private async handleInvoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!isObject(body)) {
      throw new Error("Remote invoke body must be a JSON object.");
    }

    const reconnectUuid = optionalString(body.reconnectUuid);
    if (reconnectUuid) {
      await this.resumeExecution(this.activeInvokeTasks, reconnectUuid, response);
      return;
    }

    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel) {
      throw new Error("Remote invoke is missing channel.");
    }
    const args = Array.isArray(body.args) ? body.args : [];
    const clientId = normalizeClientId(typeof body.clientId === "string" ? body.clientId : undefined);
    const uuid = randomUUID();
    const task: ActiveExecutionTask = {
      promise: Promise.resolve().then(() => this.options.invoke({ client: { id: clientId }, channel, args })),
      client: { id: clientId },
      response,
    };
    this.activeInvokeTasks.set(uuid, task);
    this.trackExecution(this.activeInvokeTasks, uuid, task);
    await this.attachExecution(this.activeInvokeTasks, uuid, task, response);
  }

  private async handleRemoteAgent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.invokeRemoteAgent) {
      throw new Error("Remote agent invocation is not available.");
    }

    const body = await readJsonBody(request);
    if (!isObject(body)) {
      throw new Error("Remote agent body must be a JSON object.");
    }

    const reconnectUuid = optionalString(body.reconnectUuid);
    if (reconnectUuid) {
      await this.resumeExecution(this.activeAgentTasks, reconnectUuid, response);
      return;
    }

    const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";
    const prompt = typeof body.prompt === "string"
      ? body.prompt
      : typeof body.question === "string"
        ? body.question
        : "";
    if (!workspacePath) {
      throw new Error("Remote agent body is missing workspacePath.");
    }
    if (!prompt.trim()) {
      throw new Error("Remote agent body is missing prompt.");
    }
    const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
      ? Math.floor(body.timeoutMs)
      : undefined;
    const codingAgent = parseRemoteCodingAgent(body.codingAgent);
    const closeOnComplete = body.closeOnComplete !== false; // default true
    const abortController = new AbortController();
    const uuid = randomUUID();
    const task: ActiveExecutionTask = {
      promise: Promise.resolve().then(() => this.options.invokeRemoteAgent!({
        clientId: normalizeClientId(typeof body.clientId === "string" ? body.clientId : "remote-agent"),
        workspacePath,
        prompt,
        codingAgent,
        sessionId: typeof body.sessionId === "string" ? body.sessionId.trim() : undefined,
        newSession: true,
        timeoutMs,
        closeOnComplete,
        signal: abortController.signal,
      })),
      abort: () => abortController.abort(),
      response,
    };
    this.activeAgentTasks.set(uuid, task);
    this.trackExecution(this.activeAgentTasks, uuid, task);
    await this.attachExecution(this.activeAgentTasks, uuid, task, response);
  }

  private async resumeExecution(
    tasks: Map<string, ActiveExecutionTask>,
    uuid: string,
    response: ServerResponse,
  ): Promise<void> {
    const task = tasks.get(uuid);
    if (!task) {
      this.sendJson(response, 404, { ok: false, error: "Task not found or already aborted on server." });
      return;
    }
    if (task.client) this.options.onExecutionConnected?.(task.client);
    await this.attachExecution(tasks, uuid, task, response);
  }

  private async attachExecution(
    tasks: Map<string, ActiveExecutionTask>,
    uuid: string,
    task: ActiveExecutionTask,
    response: ServerResponse,
  ): Promise<void> {
    if (task.disconnectTimer) {
      clearTimeout(task.disconnectTimer);
      task.disconnectTimer = undefined;
    }
    task.response = response;
    this.beginExecutionResponse(response, uuid);
    const onClose = () => {
      if (task.response !== response || response.writableEnded) return;
      task.response = undefined;
      if (task.client && !this.connections.has(task.client.id)) {
        this.options.onExecutionDisconnected?.(task.client);
      }
      task.disconnectTimer = setTimeout(() => {
        task.abort?.();
        tasks.delete(uuid);
      }, executionDisconnectGraceMs);
      task.disconnectTimer.unref();
    };
    response.once("close", onClose);
    try {
      const result = await task.promise;
      if (task.response === response) this.endExecutionResponse(response, { ok: true, result });
    } catch (error) {
      if (task.response === response) {
        this.endExecutionResponse(response, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      response.off("close", onClose);
    }
  }

  private trackExecution(
    tasks: Map<string, ActiveExecutionTask>,
    uuid: string,
    task: ActiveExecutionTask,
  ): void {
    const retainResult = () => {
      const cleanupTimer = setTimeout(() => {
        if (tasks.get(uuid) === task) tasks.delete(uuid);
      }, completedExecutionRetentionMs);
      cleanupTimer.unref();
    };
    void task.promise.then(retainResult, retainResult);
  }

  private beginExecutionResponse(response: ServerResponse, uuid: string): void {
    this.writeCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Execution-UUID": uuid,
    });
    response.flushHeaders();
  }

  private endExecutionResponse(response: ServerResponse, payload: unknown): void {
    if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify(payload));
  }

  private async serveRendererAsset(url: URL, response: ServerResponse): Promise<void> {
    const rendererRoot = path.resolve(this.options.rendererRoot);
    if (!existsSync(rendererRoot)) {
      this.sendHtml(
        response,
        503,
        `<h1>Bimanus remote UI assets are not built</h1><p>Run the desktop build first, or set PI_APP_REMOTE_UI_ASSETS_DIR to a renderer build directory.</p>`,
      );
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    let filePath = path.resolve(rendererRoot, relativePath);
    if (!isPathInside(filePath, rendererRoot)) {
      this.sendText(response, 403, "Forbidden");
      return;
    }

    let fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      filePath = path.join(rendererRoot, "index.html");
      fileStats = await stat(filePath).catch(() => undefined);
    }
    if (!fileStats?.isFile()) {
      this.sendText(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Length": fileStats.size,
      "Content-Type": mimeTypeForPath(filePath),
    });
    createReadStream(filePath).pipe(response);
  }

  private requireAuthorized(request: IncomingMessage, url: URL): void {
    const token = this.options.getToken().trim();
    if (!token) {
      throw new Error("Remote UI token is not configured.");
    }
    const header = request.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const queryToken = url.searchParams.get("token")?.trim() ?? "";
    const legacyHeader = Array.isArray(request.headers["x-pi-remote-ui-token"])
      ? request.headers["x-pi-remote-ui-token"][0]
      : request.headers["x-pi-remote-ui-token"];
    if (bearer === token || queryToken === token || legacyHeader === token) {
      return;
    }
    const error = new Error("Unauthorized remote UI request.");
    error.name = "UnauthorizedRemoteUiRequest";
    throw error;
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    this.writeCorsHeaders(response);
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  private sendText(response: ServerResponse, statusCode: number, text: string): void {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(text);
  }

  private sendHtml(response: ServerResponse, statusCode: number, html: string): void {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Bimanus remote UI</title>${html}`);
  }

  private writeCorsHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Pi-Remote-Ui-Token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "X-Execution-UUID");
  }
}

function resolveListeningPort(address: string | AddressInfo | null, fallbackPort: number): number {
  return typeof address === "object" && address ? address.port : fallbackPort;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxJsonBodyBytes) {
      throw new Error("Remote request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeSseEvent(response: ServerResponse, eventName: string, payload: unknown): void {
  // Combine the entire SSE frame into a single write() call. Node's
  // Writable stream will issue one raw write to the kernel, avoiding
  // partial-frame buffering that can delay small echo events on mobile.
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function normalizeClientId(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (candidate && /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)) {
    return candidate;
  }
  return "default";
}

function isPathInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRemoteCodingAgent(value: unknown): RemoteCodingAgent {
  switch (value) {
    case "codex":
    case "claude-code":
    case "opencode":
    case "grok":
    case "copilot":
    case "antigravity":
    case "kiro":
    case "cursor":
    case "droid":
      return value;
    default:
      return "pi-coding-agent";
  }
}

function mimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
