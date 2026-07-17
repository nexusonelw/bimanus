import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../desktop-state";

const SIDEBAR_RESIZE_MEDIA_QUERY = "(max-width: 980px)";

interface UseSidebarResizeOptions {
  readonly width: number;
  readonly disabled?: boolean;
  readonly onWidthChange: (width: number) => void;
  readonly onWidthCommit: (width: number) => void;
}

function clampSidebarWidth(width: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function useSidebarResize({
  width,
  disabled = false,
  onWidthChange,
  onWidthCommit,
}: UseSidebarResizeOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(false);
  const currentWidthRef = useRef(width);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    currentWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) {
        return;
      }
      if (window.matchMedia(SIDEBAR_RESIZE_MEDIA_QUERY).matches) {
        return;
      }

      event.preventDefault();
      activeRef.current = false;
      cleanupRef.current?.();
      cleanupRef.current = null;

      const startX = event.clientX;
      const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.5)));
      const startWidth = clampSidebarWidth(width, maxWidth);

      activeRef.current = true;
      currentWidthRef.current = startWidth;
      onWidthChange(startWidth);

      const handleMove = (moveEvent: MouseEvent) => {
        if (!activeRef.current) {
          return;
        }
        const nextWidth = clampSidebarWidth(startWidth + (moveEvent.clientX - startX), maxWidth);
        currentWidthRef.current = nextWidth;
        onWidthChange(nextWidth);
      };

      let handleUp: () => void;
      let handleBlur: () => void;
      const cleanup = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("blur", handleBlur);
      };

      handleUp = () => {
        if (!activeRef.current) {
          return;
        }
        activeRef.current = false;
        cleanup();
        cleanupRef.current = null;
        setIsResizing(false);
        onWidthCommit(currentWidthRef.current);
      };

      handleBlur = () => {
        handleUp();
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleBlur);
      cleanupRef.current = cleanup;
      setIsResizing(true);
    },
    [disabled, onWidthChange, onWidthCommit, width],
  );

  return { startResize, isResizing } as const;
}
