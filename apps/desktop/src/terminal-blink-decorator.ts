import type { IDisposable, Terminal } from "@xterm/xterm";

const BLINK_CLASS_NAME = "terminal-panel__xterm-blink";
// ponytail: DOM decoration can lag by 100ms; use range-aware decoration if ANSI blink becomes common.
const BLINK_DECORATION_MIN_INTERVAL_MS = 100;

export function installTerminalBlinkDecorator(terminal: Terminal, container: HTMLElement): IDisposable {
  let frameHandle = 0;
  let timeoutHandle = 0;
  let lastRefreshAt = 0;

  const scheduleRefresh = () => {
    if (frameHandle || timeoutHandle) {
      return;
    }
    const delay = Math.max(0, BLINK_DECORATION_MIN_INTERVAL_MS - (performance.now() - lastRefreshAt));
    if (delay > 0) {
      timeoutHandle = window.setTimeout(() => {
        timeoutHandle = 0;
        scheduleRefresh();
      }, delay);
      return;
    }
    frameHandle = window.requestAnimationFrame(() => {
      frameHandle = 0;
      lastRefreshAt = performance.now();
      applyBlinkDecorations(terminal, container);
    });
  };

  const renderDisposable = terminal.onRender(scheduleRefresh);
  const writeParsedDisposable = terminal.onWriteParsed(scheduleRefresh);
  scheduleRefresh();

  return {
    dispose: () => {
      renderDisposable.dispose();
      writeParsedDisposable.dispose();
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      }
      if (timeoutHandle) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = 0;
      }
    },
  };
}

function applyBlinkDecorations(terminal: Terminal, container: HTMLElement): void {
  const rowElements = container.querySelectorAll<HTMLElement>(".xterm-rows > div");
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();

  rowElements.forEach((rowElement, viewportRow) => {
    const line = buffer.getLine(buffer.viewportY + viewportRow);
    if (!line) {
      clearBlinkDecorations(rowElement);
      return;
    }

    let column = 0;
    rowElement.querySelectorAll<HTMLElement>("span").forEach((span) => {
      const width = renderedCellWidth(span.textContent ?? "");
      const endColumn = Math.min(terminal.cols, column + width);
      let hasBlink = false;

      for (let x = column; x < endColumn; x += 1) {
        if (line.getCell(x, cell)?.isBlink()) {
          hasBlink = true;
          break;
        }
      }

      span.classList.toggle(BLINK_CLASS_NAME, hasBlink);
      column = endColumn;
    });
  });
}

function clearBlinkDecorations(rowElement: HTMLElement): void {
  rowElement.querySelectorAll<HTMLElement>(`.${BLINK_CLASS_NAME}`).forEach((span) => {
    span.classList.remove(BLINK_CLASS_NAME);
  });
}

function renderedCellWidth(text: string): number {
  return Math.max(1, Array.from(text).length);
}
