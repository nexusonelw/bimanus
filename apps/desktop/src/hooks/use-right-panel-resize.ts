import { useCallback, useEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
import {
  normalizeRightPanelWidth,
  RIGHT_PANEL_WIDTH_LIMITS,
  type RightPanelWidthKey,
  type RightPanelWidths,
} from "../desktop-state";

export type RightPanelResizeEdge = "left" | "right";

interface UseRightPanelResizeOptions {
  readonly disabled: boolean;
  readonly openPanels: readonly RightPanelWidthKey[];
  readonly panelWidths: RightPanelWidths;
  readonly onWidthsChange: (widths: RightPanelWidths) => void;
  readonly onWidthsCommit: (widths: RightPanelWidths) => void;
}

interface ResizeHandleAvailability {
  readonly left: boolean;
  readonly right: boolean;
}

interface DragState {
  readonly startX: number;
  readonly startWidths: RightPanelWidths;
  latestWidths: RightPanelWidths;
}

function clampDeltaForDivider(
  delta: number,
  leftPanel: RightPanelWidthKey,
  rightPanel: RightPanelWidthKey,
  startWidths: RightPanelWidths,
): number {
  const leftLimits = RIGHT_PANEL_WIDTH_LIMITS[leftPanel];
  const rightLimits = RIGHT_PANEL_WIDTH_LIMITS[rightPanel];
  const leftStart = startWidths[leftPanel];
  const rightStart = startWidths[rightPanel];
  const minDelta = Math.max(leftLimits.min - leftStart, rightStart - rightLimits.max);
  const maxDelta = Math.min(leftLimits.max - leftStart, rightStart - rightLimits.min);
  return Math.min(maxDelta, Math.max(minDelta, delta));
}

function applySinglePanelResize(
  panel: RightPanelWidthKey,
  startWidths: RightPanelWidths,
  nextWidth: number,
): RightPanelWidths {
  return {
    ...startWidths,
    [panel]: normalizeRightPanelWidth(panel, nextWidth),
  };
}

function preventResizeEvent(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function useRightPanelResize({
  disabled,
  openPanels,
  panelWidths,
  onWidthsChange,
  onWidthsCommit,
}: UseRightPanelResizeOptions) {
  const panelWidthsRef = useRef(panelWidths);
  const onWidthsChangeRef = useRef(onWidthsChange);
  const onWidthsCommitRef = useRef(onWidthsCommit);
  const activeDragRef = useRef<DragState | null>(null);

  useEffect(() => {
    panelWidthsRef.current = panelWidths;
  }, [panelWidths]);

  useEffect(() => {
    onWidthsChangeRef.current = onWidthsChange;
  }, [onWidthsChange]);

  useEffect(() => {
    onWidthsCommitRef.current = onWidthsCommit;
  }, [onWidthsCommit]);

  useEffect(() => {
    return () => {
      document.body.classList.remove("right-panel-resizing");
      activeDragRef.current = null;
    };
  }, []);

  const beginResize = useCallback((panel: RightPanelWidthKey, edge: RightPanelResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) {
      return;
    }
    const panelIndex = openPanels.indexOf(panel);
    if (panelIndex === -1) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const startWidths = panelWidthsRef.current;
    const dragState: DragState = {
      startX: event.clientX,
      startWidths,
      latestWidths: startWidths,
    };
    activeDragRef.current = dragState;
    document.body.classList.add("right-panel-resizing");

    const previousPanel = edge === "left" && panelIndex > 0 ? openPanels[panelIndex - 1] : undefined;
    const resizingDivider = Boolean(previousPanel);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      preventResizeEvent(moveEvent);
      const activeDrag = activeDragRef.current;
      if (!activeDrag) {
        return;
      }
      const delta = moveEvent.clientX - activeDrag.startX;
      let nextWidths: RightPanelWidths;
      if (resizingDivider && previousPanel) {
        const adjustedDelta = clampDeltaForDivider(delta, previousPanel, panel, activeDrag.startWidths);
        nextWidths = {
          ...activeDrag.startWidths,
          [previousPanel]: normalizeRightPanelWidth(previousPanel, activeDrag.startWidths[previousPanel] + adjustedDelta),
          [panel]: normalizeRightPanelWidth(panel, activeDrag.startWidths[panel] - adjustedDelta),
        };
      } else if (edge === "left") {
        nextWidths = applySinglePanelResize(panel, activeDrag.startWidths, activeDrag.startWidths[panel] - delta);
      } else {
        nextWidths = applySinglePanelResize(panel, activeDrag.startWidths, activeDrag.startWidths[panel] + delta);
      }
      activeDrag.latestWidths = nextWidths;
      onWidthsChangeRef.current(nextWidths);
    };

    const finishResize = (finishEvent: PointerEvent) => {
      preventResizeEvent(finishEvent);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", finishResize, true);
      window.removeEventListener("pointercancel", finishResize, true);
      document.body.classList.remove("right-panel-resizing");
      const activeDrag = activeDragRef.current;
      activeDragRef.current = null;
      if (activeDrag) {
        onWidthsCommitRef.current(activeDrag.latestWidths);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", finishResize, true);
    window.addEventListener("pointercancel", finishResize, true);
  }, [disabled, openPanels]);

  const getResizeHandleAvailability = useCallback((panel: RightPanelWidthKey): ResizeHandleAvailability => {
    if (disabled) {
      return { left: false, right: false };
    }
    const panelIndex = openPanels.indexOf(panel);
    if (panelIndex === -1) {
      return { left: false, right: false };
    }
    return {
      left: true,
      right: panelIndex === openPanels.length - 1,
    };
  }, [disabled, openPanels]);

  const getResizeHandleProps = useCallback((
    panel: RightPanelWidthKey,
    edge: RightPanelResizeEdge,
  ): HTMLAttributes<HTMLDivElement> => ({
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize panel",
    className: `right-panel-resize-handle right-panel-resize-handle--${edge}`,
    onPointerDown: (event) => beginResize(panel, edge, event),
  }), [beginResize]);

  return {
    getResizeHandleAvailability,
    getResizeHandleProps,
  };
}
