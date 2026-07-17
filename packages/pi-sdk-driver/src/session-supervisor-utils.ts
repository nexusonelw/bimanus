import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type {
  SessionAttachment,
  SessionConfig,
  SessionErrorInfo,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  WorkspaceRef,
} from "@bimanus/session-driver";
import type { SessionQueuedMessage } from "@bimanus/session-driver/types";
import type { SessionTranscriptAttachment, SessionTranscriptItem, SessionTranscriptToolCall } from "./transcript.js";

const FILE_ATTACHMENT_BLOCK_START = "<pi-gui-file-attachments>";
const FILE_ATTACHMENT_BLOCK_END = "</pi-gui-file-attachments>";

export interface SnapshotSource {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly archivedAt: string | undefined;
  readonly preview: string | undefined;
  readonly config: SessionConfig | undefined;
  readonly runningRunId: string | undefined;
  readonly queuedMessages: readonly SessionQueuedMessage[];
}

export function buildSnapshot(source: SnapshotSource): SessionSnapshot {
  return {
    ref: { ...source.ref },
    workspace: { ...source.workspace },
    title: source.title.trim() || deriveWorkspaceTitle(source.workspace),
    status: source.status,
    updatedAt: source.updatedAt,
    ...(source.archivedAt !== undefined ? { archivedAt: source.archivedAt } : {}),
    ...(source.preview !== undefined ? { preview: source.preview } : {}),
    ...(source.config ? { config: source.config } : {}),
    ...(source.runningRunId !== undefined ? { runningRunId: source.runningRunId } : {}),
    ...(source.queuedMessages.length > 0
      ? {
          queuedMessages: source.queuedMessages.map((message) => ({
            ...message,
            ...(message.attachments
              ? {
                  attachments: message.attachments.map((attachment: SessionAttachment) => ({ ...attachment })),
                }
              : {}),
          })),
        }
      : {}),
  };
}

export function deriveSessionConfig(sessionManager: {
  buildSessionContext(): {
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}): SessionConfig | undefined {
  const context = sessionManager.buildSessionContext();
  const config: SessionConfig = {
    ...(context.model ? { provider: context.model.provider, modelId: context.model.modelId } : {}),
    ...(context.thinkingLevel && context.thinkingLevel !== "off" ? { thinkingLevel: context.thinkingLevel } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function forcePersistSession(sessionManager: object): void {
  const maybeRewrite = (sessionManager as { _rewriteFile?: () => void })._rewriteFile;
  maybeRewrite?.call(sessionManager);
  if (maybeRewrite) {
    (sessionManager as { flushed?: boolean }).flushed = true;
  }
}

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

export function workspaceToRef(workspace: { workspaceId: string; path: string; displayName: string }): WorkspaceRef {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    displayName: workspace.displayName,
  };
}

export function deriveWorkspaceTitle(workspace: WorkspaceRef): string {
  return workspace.displayName?.trim() || basename(workspace.path) || workspace.path;
}

export function createWorkspaceRef(path: string, displayName?: string): WorkspaceRef {
  return {
    workspaceId: path,
    path,
    ...(displayName ? { displayName } : {}),
  };
}

export function titleFromSessionInfo(info: SessionInfo): string {
  const preferred = info.name?.trim();
  if (preferred) {
    return preferred;
  }

  const firstMessage = truncate(info.firstMessage, 72);
  if (firstMessage) {
    return firstMessage;
  }

  return basename(info.cwd || info.path);
}

export function previewFromSessionInfo(info: SessionInfo): string | undefined {
  const text = truncate(info.firstMessage || info.allMessagesText, 140);
  return text || undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function extractPreview(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const text = messageText(message);
  if (text) {
    return truncate(text);
  }

  if (typeof message.stopReason === "string" && typeof message.errorMessage === "string") {
    return truncate(message.errorMessage);
  }

  return undefined;
}

export function determineRunOutcome(messages: readonly unknown[]): {
  success: boolean;
  error?: SessionErrorInfo;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      const messageText =
        typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
          ? message.errorMessage
          : stopReason === "aborted"
            ? "Run aborted"
            : "Run failed";
      return {
        success: false,
        error: {
          message: messageText,
          code: stopReason.toUpperCase(),
        },
      };
    }
    break;
  }

  return { success: true };
}

export function toSessionErrorInfo(error: unknown, code: string): SessionErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      code,
      details: {
        name: error.name,
        stack: error.stack,
      },
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown error",
    code,
    details: error,
  };
}

export function truncate(value: string, limit = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function injectFileAttachmentPreamble(
  text: string,
  attachments: readonly SessionAttachment[] | undefined,
): string {
  const files = attachments?.filter((attachment): attachment is Extract<SessionAttachment, { readonly kind: "file" }> => attachment.kind === "file") ?? [];
  if (files.length === 0) {
    return text;
  }

  const payload = JSON.stringify({
    version: 1,
    files: files.map((attachment) => ({
      kind: "file" as const,
      name: attachment.name,
      mimeType: attachment.mimeType,
      fsPath: attachment.fsPath,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    })),
  });
  const block = `${FILE_ATTACHMENT_BLOCK_START}${payload}${FILE_ATTACHMENT_BLOCK_END}`;
  return text ? `${block}\n${text}` : block;
}

export function transcriptFromMessages(messages: readonly unknown[], fallbackTimestamp = nowIso()): SessionTranscriptItem[] {
  const transcript: SessionTranscriptItem[] = [];
  const toolRowIndexByCallId = new Map<string, number>();

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      continue;
    }

    const role = message.role;
    if (role === "toolResult") {
      const toolResult = toolResultFromMessage(message, fallbackTimestamp, index);
      if (!toolResult) {
        continue;
      }
      const existingIndex = toolRowIndexByCallId.get(toolResult.callId);
      if (existingIndex !== undefined) {
        const existing = transcript[existingIndex];
        if (existing?.kind === "tool") {
          transcript[existingIndex] = {
            ...existing,
            status: toolResult.status,
            ...(toolResult.detail ? { detail: toolResult.detail } : {}),
            ...(toolResult.output !== undefined ? { output: toolResult.output } : {}),
          };
        }
      } else {
        toolRowIndexByCallId.set(toolResult.callId, transcript.length);
        transcript.push(toolResult);
      }
      continue;
    }

    if (role !== "user" && role !== "assistant" && role !== "branchSummary" && role !== "compactionSummary") {
      continue;
    }

    const text = messageText(message);
    const attachments = messageAttachments(message);
    const createdAt = messageCreatedAt(message, fallbackTimestamp);
    if (!text) {
      if (attachments.length === 0) {
        if (role !== "assistant") {
          continue;
        }
      } else {
        transcript.push({
          kind: "message",
          id: typeof message.id === "string" ? message.id : `${role}-${index}`,
          role,
          text,
          attachments,
          createdAt,
        });
      }
    } else {
      transcript.push({
        kind: "message",
        id: typeof message.id === "string" ? message.id : `${role}-${index}`,
        role,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt,
      });
    }

    if (role === "assistant") {
      for (const toolCall of toolCallsFromAssistant(message, createdAt)) {
        const existingIndex = toolRowIndexByCallId.get(toolCall.callId);
        if (existingIndex !== undefined) {
          const existing = transcript[existingIndex];
          if (existing?.kind === "tool") {
            transcript[existingIndex] = {
              ...toolCall,
              status: existing.status,
              ...(existing.detail ? { detail: existing.detail } : {}),
              ...(existing.output !== undefined ? { output: existing.output } : {}),
            };
          }
          continue;
        }
        toolRowIndexByCallId.set(toolCall.callId, transcript.length);
        transcript.push(toolCall);
      }
    }
  }

  return transcript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageCreatedAt(message: Record<string, unknown>, fallbackTimestamp: string): string {
  if (typeof message.createdAt === "string") {
    return message.createdAt;
  }
  if (typeof message.timestamp === "string") {
    return message.timestamp;
  }
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  return fallbackTimestamp;
}

function toolCallsFromAssistant(message: Record<string, unknown>, createdAt: string): SessionTranscriptToolCall[] {
  const { content } = message;
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part, index) => {
    if (!isRecord(part) || part.type !== "toolCall") {
      return [];
    }
    const callId = typeof part.id === "string" ? part.id : `tool-${index}`;
    const toolName = typeof part.name === "string" ? part.name : "tool";
    const input = isRecord(part.arguments) ? part.arguments : part.arguments;
    return [{
      kind: "tool" as const,
      id: callId,
      callId,
      toolName,
      status: "running" as const,
      label: toolLabel(toolName, input),
      createdAt,
      ...(input !== undefined ? { input } : {}),
    }];
  });
}

function toolResultFromMessage(
  message: Record<string, unknown>,
  fallbackTimestamp: string,
  index: number,
): SessionTranscriptToolCall | undefined {
  const callId = typeof message.toolCallId === "string" ? message.toolCallId : `tool-result-${index}`;
  const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
  const output = toolOutput(message);
  const status = message.isError === true ? "error" : "success";
  const detail = status === "error" ? toolErrorDetail(output) : undefined;
  return {
    kind: "tool",
    id: callId,
    callId,
    toolName,
    status,
    label: toolLabel(toolName, undefined),
    ...(detail ? { detail } : {}),
    createdAt: messageCreatedAt(message, fallbackTimestamp),
    ...(output !== undefined ? { output } : {}),
  };
}

function toolOutput(message: Record<string, unknown>): unknown {
  const { content } = message;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textParts = content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  if (textParts.length === 1) {
    return textParts[0];
  }
  if (textParts.length > 1) {
    return textParts.join("\n");
  }
  return content.length > 0 ? content : undefined;
}

function toolErrorDetail(output: unknown): string | undefined {
  const text = typeof output === "string" ? output : undefined;
  return text?.split("\n").find((line) => line.trim())?.trim().slice(0, 160);
}

function toolLabel(toolName: string, input: unknown): string {
  const detail = toolDetail(input);
  if (/(read|glob|ls|list|open|find|grep|search)/i.test(toolName)) {
    return detail ? `Explored ${detail}` : `Explored files with ${toolName}`;
  }
  if (/(write|edit|patch|apply)/i.test(toolName)) {
    return detail ? `Edited ${detail}` : `Edited with ${toolName}`;
  }
  return detail ? `Ran ${toolName}: ${detail}` : `Ran ${toolName}`;
}

function toolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input.path ?? input.file_path ?? input.filePath ?? input.filename ?? input.pattern ?? input.command;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

export function messageText(message: Record<string, unknown>): string {
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    return typeof message.summary === "string" ? message.summary.trim() : "";
  }

  const { content } = message;
  if (typeof content === "string") {
    return stripSerializedFileAttachments(content, message.role).text.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? stripSerializedFileAttachments(part.text, message.role).text
          : "",
      )
      .filter((text) => text.length > 0)
      .join("\n\n")
      .trim();
  }

  return "";
}

function messageAttachments(message: Record<string, unknown>) {
  const { content } = message;
  if (typeof content === "string") {
    return stripSerializedFileAttachments(content, message.role).attachments;
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      return stripSerializedFileAttachments(part.text, message.role).attachments;
    }

    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") {
      return [];
    }

    return [
      {
        kind: "image" as const,
        data: part.data,
        mimeType: part.mimeType,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      },
    ];
  });
}

function stripSerializedFileAttachments(
  text: string,
  role: unknown,
): { readonly text: string; readonly attachments: readonly SessionTranscriptAttachment[] } {
  if (role !== "user" || !text.startsWith(FILE_ATTACHMENT_BLOCK_START)) {
    return {
      text,
      attachments: [],
    };
  }

  const endIndex = text.indexOf(FILE_ATTACHMENT_BLOCK_END, FILE_ATTACHMENT_BLOCK_START.length);
  if (endIndex < 0) {
    return {
      text,
      attachments: [],
    };
  }

  const payload = text.slice(FILE_ATTACHMENT_BLOCK_START.length, endIndex);
  const remainder = text.slice(endIndex + FILE_ATTACHMENT_BLOCK_END.length).replace(/^\n+/, "");
  const attachments = parseSerializedFileAttachments(payload);
  if (attachments.length === 0) {
    return {
      text,
      attachments: [],
    };
  }

  return {
    text: remainder,
    attachments,
  };
}

function parseSerializedFileAttachments(payload: string): SessionTranscriptAttachment[] {
  try {
    const parsed = JSON.parse(payload) as { readonly version?: unknown; readonly files?: readonly unknown[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      return [];
    }

    return parsed.files.flatMap((entry) => {
      if (!isRecord(entry) || entry.kind !== "file" || typeof entry.name !== "string" || typeof entry.mimeType !== "string" || typeof entry.fsPath !== "string") {
        return [];
      }

      return [
        {
          kind: "file" as const,
          name: entry.name,
          mimeType: entry.mimeType,
          fsPath: entry.fsPath,
          ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
