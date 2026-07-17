export interface TerminalReplayUpdate {
  readonly replay: string;
  readonly truncated: boolean;
}

export function appendTerminalReplay(
  replay: string,
  data: string,
  _alreadyTruncated = false,
): TerminalReplayUpdate {
  return {
    replay: replay + data,
    truncated: false,
  };
}
