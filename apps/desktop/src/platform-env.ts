/**
 * Platform environment detection utilities.
 *
 * Centralises all host-environment checks so that individual UI components
 * never need to inspect `navigator.userAgent` or other browser globals
 * directly. Add any future platform-capability probes here rather than
 * scattering them across component files.
 */

/**
 * Returns `true` when the page is running inside an Electron renderer process.
 *
 * Electron embeds its version string into the User-Agent, e.g.
 *   "Mozilla/5.0 … Electron/29.0.0 Chrome/…"
 * A plain browser (used in remote-UI mode) will never contain "electron".
 *
 * This check is intentionally cheap and synchronous so it can be called at
 * the top of any event handler without observable cost.
 */
export function isElectronHost(): boolean {
  return /electron/i.test(navigator.userAgent);
}
