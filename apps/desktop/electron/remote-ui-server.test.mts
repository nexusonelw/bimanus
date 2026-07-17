import { describe, expect, it } from "bun:test";
import { RemoteUiServer } from "./remote-ui-server.ts";

describe("RemoteUiServer execution reconnect", () => {
  it("returns a UUID before completion and resumes the same invocation", async () => {
    let finish!: (value: unknown) => void;
    let calls = 0;
    const server = new RemoteUiServer({
      host: "127.0.0.1",
      port: 0,
      getToken: () => "test-token",
      rendererRoot: "/missing",
      invoke: () => {
        calls += 1;
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    const { url } = await server.start();
    const controller = new AbortController();
    const post = (body: object, signal?: AbortSignal) => fetch(`${url}api/invoke`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    try {
      const first = await post({ clientId: "test", channel: "test", args: [] }, controller.signal);
      const uuid = first.headers.get("X-Execution-UUID");
      expect(uuid).toBeTruthy();
      void first.json().catch(() => undefined);
      controller.abort();

      const resumedPromise = post({ reconnectUuid: uuid });
      finish({ resumed: true });
      const resumed = await resumedPromise;
      expect(resumed.headers.get("X-Execution-UUID")).toBe(uuid);
      expect(await resumed.json()).toEqual({ ok: true, result: { resumed: true } });
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });
});
