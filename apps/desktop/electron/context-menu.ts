import { BrowserWindow, clipboard, ipcMain, Menu, type IpcMainInvokeEvent, type PopupOptions } from "electron";
import { desktopIpc, type CopySelectionContextMenuInput } from "../src/ipc";

const MAX_COPY_SELECTION_TEXT_LENGTH = 500_000;

export function installCopySelectionContextMenu(): void {
  ipcMain.handle(desktopIpc.showCopySelectionContextMenu, showCopySelectionContextMenu);
}

function showCopySelectionContextMenu(event: IpcMainInvokeEvent, input: unknown): Promise<boolean> {
  const selectedText = normalizeSelectedText(input);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    return Promise.resolve(false);
  }

  const popupOptions = buildPopupOptions(window, input);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (copied: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(copied);
    };

    const menu = Menu.buildFromTemplate([
      {
        label: "复制",
        enabled: selectedText.trim().length > 0,
        click: () => {
          if (!selectedText.trim()) {
            finish(false);
            return;
          }
          clipboard.writeText(selectedText);
          finish(true);
        },
      },
    ]);

    menu.popup({
      ...popupOptions,
      callback: () => finish(false),
    });
  });
}

function normalizeSelectedText(input: unknown): string {
  if (!isCopySelectionContextMenuInput(input)) {
    return "";
  }

  return input.selectedText.length > MAX_COPY_SELECTION_TEXT_LENGTH
    ? input.selectedText.slice(0, MAX_COPY_SELECTION_TEXT_LENGTH)
    : input.selectedText;
}

function buildPopupOptions(window: BrowserWindow, input: unknown): PopupOptions {
  const popupOptions: PopupOptions = { window };
  if (!isCopySelectionContextMenuInput(input)) {
    return popupOptions;
  }

  if (
    typeof input.x === "number" &&
    typeof input.y === "number" &&
    Number.isFinite(input.x) &&
    Number.isFinite(input.y)
  ) {
    popupOptions.x = Math.round(input.x);
    popupOptions.y = Math.round(input.y);
  }
  return popupOptions;
}

function isCopySelectionContextMenuInput(value: unknown): value is CopySelectionContextMenuInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CopySelectionContextMenuInput>;
  const hasValidPosition =
    candidate.x === undefined ||
    candidate.y === undefined ||
    (typeof candidate.x === "number" && typeof candidate.y === "number");
  return typeof candidate.selectedText === "string" && hasValidPosition;
}
