import type {
  SessionTranscriptItem,
  SessionTranscriptMessage,
  SessionTranscriptRole,
  SessionTranscriptToolCall,
} from "@bimanus/pi-sdk-driver";

export type SessionRole = SessionTranscriptRole;
export type TimelineTone = "neutral" | "success" | "warning" | "error";
export type TimelineToolStatus = "running" | "success" | "error";
export type TimelineSummaryPresentation = "inline" | "divider";

export interface TimelineActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly tone?: TimelineTone;
}

export type TimelineToolCall = SessionTranscriptToolCall;

export interface TimelineSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly metadata?: string;
  readonly presentation: TimelineSummaryPresentation;
}

export type TranscriptMessage = SessionTranscriptItem | TimelineActivity | TimelineSummary;
