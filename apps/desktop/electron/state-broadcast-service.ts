/**
 * StateBroadcastService — extracted from DesktopAppStore (God Object slimming).
 *
 * Owns the listener registries and publication logic for:
 * - Full state snapshots (emit / subscribe)
 * - Session events (emitSessionEvent / subscribeToSessionEvents)
 *
 * The store delegates to this service so that the ~3500-line app-store.ts
 * no longer carries broadcast infrastructure inline.  Future extractions
 * (persistence, workspace sync, etc.) should follow the same pattern.
 */

import type { DesktopAppState } from "../src/desktop-state";
import type { SessionDriverEvent } from "@bimanus/session-driver";

export type StateListener = (state: DesktopAppState) => void;
export type SessionEventListener = (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>;

export interface StateBroadcastDeps {
  /** Returns the current canonical state (NOT a clone). */
  readonly getState: () => DesktopAppState;
}

export class StateBroadcastService {
  private readonly listeners = new Set<StateListener>();
  private readonly sessionEventListeners = new Set<SessionEventListener>();

  constructor(private readonly deps: StateBroadcastDeps) {}

  /* ── Subscriptions ─────────────────────────────────────── */

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeToSessionEvents(listener: SessionEventListener): () => void {
    this.sessionEventListeners.add(listener);
    return () => {
      this.sessionEventListeners.delete(listener);
    };
  }

  /* ── Publication ───────────────────────────────────────── */

  /**
   * Clone the full state and broadcast to all state listeners.
   * This is the canonical "emit" call used throughout the store.
   */
  emit(): DesktopAppState {
    const snapshot = structuredClone(this.deps.getState());
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  /**
   * Broadcast a session event + snapshot to all session event listeners.
   */
  async emitSessionEvent(event: SessionDriverEvent, snapshot: DesktopAppState): Promise<void> {
    for (const listener of this.sessionEventListeners) {
      await listener(event, snapshot);
    }
  }
}
