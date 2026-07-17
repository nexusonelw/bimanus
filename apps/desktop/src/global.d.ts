import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { PiDesktopApi } from "./ipc";

export {};

type ElectronWebViewAttributes = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  readonly allowpopups?: boolean | string;
  readonly partition?: string;
  readonly src?: string;
  readonly webpreferences?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: ElectronWebViewAttributes;
    }
  }
}

declare global {
  interface Window {
    piApp?: PiDesktopApi;
  }
}
