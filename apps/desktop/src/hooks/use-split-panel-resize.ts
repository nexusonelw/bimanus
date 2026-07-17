/**
 * ============================================================
 * useSplitPanelResize — 分屏面板分割条拖拽 Resize Hook
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §2.3 中间分割条
 *
 * 与 useSidebarResize 模式一致：
 * - mousedown → mousemove 计算差值 → 更新 CSS 变量
 * - mouseup → 可选的持久化回调
 *
 * 默认宽度: 除去侧边栏和分割条后的可用宽度的一半
 * 最小宽度: 400px
 * 最大宽度: min(80vw, 1200px)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_SPLIT_PANEL_WIDTH, MAX_SPLIT_PANEL_WIDTH } from "../split-panel/types";

export interface UseSplitPanelResizeOptions {
  /** 初始宽度（像素） */
  initialWidth?: number;

  /** 最小宽度 */
  minWidth?: number;

  /** 最大宽度 */
  maxWidth?: number;

  /** 侧边栏宽度（影响默认值计算） */
  sidebarWidth?: number;

  /** 窗口总宽度 */
  windowWidth?: number;

  /** 是否禁用拖拽 */
  disabled?: boolean;

  /** 宽度变化回调 */
  onResize?: (width: number) => void;

  /** 拖拽结束回调（用于持久化） */
  onResizeCommit?: (width: number) => void;
}

export interface UseSplitPanelResizeReturn {
  /** 当前宽度（像素） */
  width: number;

  /** 是否正在拖拽 */
  isDragging: boolean;

  /** 拖拽手柄的 onMouseDown 处理器 */
  handleMouseDown: (e: React.MouseEvent) => void;

  /** 重置为默认宽度 */
  resetWidth: () => void;

  /** 设置宽度 */
  setWidth: (width: number) => void;
}

/**
 * 计算默认宽度
 * 逻辑: (windowWidth - sidebarWidth - dividerWidth(6px)) / 2
 */
function computeDefaultWidth(sidebarWidth = 292, windowWidth?: number): number {
  const vw = windowWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1200);
  const defaultWidth = (vw - sidebarWidth - 6) / 2;
  return Math.max(MIN_SPLIT_PANEL_WIDTH, Math.min(MAX_SPLIT_PANEL_WIDTH, Math.round(defaultWidth)));
}

export function useSplitPanelResize(
  options: UseSplitPanelResizeOptions = {},
): UseSplitPanelResizeReturn {
  const {
    initialWidth,
    minWidth = MIN_SPLIT_PANEL_WIDTH,
    maxWidth = MAX_SPLIT_PANEL_WIDTH,
    sidebarWidth = 292,
    windowWidth,
    disabled = false,
    onResize,
    onResizeCommit,
  } = options;

  const defaultWidth = initialWidth ?? computeDefaultWidth(sidebarWidth, windowWidth);
  const [width, setWidthState] = useState(defaultWidth);
  const [isDragging, setIsDragging] = useState(false);

  const widthRef = useRef(width);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const onResizeRef = useRef(onResize);
  const onResizeCommitRef = useRef(onResizeCommit);

  // 保持回调引用最新
  onResizeRef.current = onResize;
  onResizeCommitRef.current = onResizeCommit;
  widthRef.current = width;

  // ── Mouse handlers ──

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;

      e.preventDefault();
      e.stopPropagation();

      startXRef.current = e.clientX;
      startWidthRef.current = widthRef.current;
      setIsDragging(true);
    },
    [disabled],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      // 分屏在右侧，拖动的是左边界：鼠标右移 → 分屏变窄
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(
        minWidth,
        Math.min(maxWidth, startWidthRef.current - delta),
      );

      setWidthState(newWidth);
      onResizeRef.current?.(newWidth);

      // 更新 CSS 变量
      document.documentElement.style.setProperty(
        "--split-panel-width",
        `${newWidth}px`,
      );
    },
    [isDragging, minWidth, maxWidth],
  );

  const handleMouseUp = useCallback(
    (_e: MouseEvent) => {
      if (!isDragging) return;

      setIsDragging(false);
      onResizeCommitRef.current?.(widthRef.current);
    },
    [isDragging],
  );

  // ── Events binding ──

  useEffect(() => {
    if (!isDragging) return;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    // 拖拽时禁用文本选择
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // ── Public API ──

  const resetWidth = useCallback(() => {
    const newWidth = computeDefaultWidth(sidebarWidth, windowWidth);
    setWidthState(newWidth);
    document.documentElement.style.setProperty(
      "--split-panel-width",
      `${newWidth}px`,
    );
    onResizeRef.current?.(newWidth);
  }, [sidebarWidth, windowWidth]);

  const setWidth = useCallback(
    (newWidth: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidthState(clamped);
      document.documentElement.style.setProperty(
        "--split-panel-width",
        `${clamped}px`,
      );
      onResizeRef.current?.(clamped);
    },
    [minWidth, maxWidth],
  );

  return {
    width,
    isDragging,
    handleMouseDown,
    resetWidth,
    setWidth,
  };
}
