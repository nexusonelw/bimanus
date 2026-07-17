/**
 * UUID generation that works in non-secure HTTP contexts.
 *
 * `crypto.randomUUID()` is only defined in secure contexts (HTTPS or
 * `localhost`). When pi-gui's remote UI is served over plain HTTP on a
 * LAN IP (e.g. `http://100.110.254.70:43174`), `crypto.randomUUID` is
 * `undefined` and would throw a TypeError. This module falls back to a
 * RFC 4122 v4 implementation backed by `crypto.getRandomValues`, which
 * is available in all modern browsers regardless of security context.
 */

export function safeRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return generateUuidV4();
}

function generateUuidV4(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}