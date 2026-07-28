import assert from "node:assert/strict";
import test from "node:test";
import { applyRemoteUiCliArgsToEnv, parseRemoteUiCliArgs } from "./remote-ui-cli.ts";

test("parseRemoteUiCliArgs reads space and equals forms", () => {
  const parsed = parseRemoteUiCliArgs([
    "--remote-ui",
    "--remote-ui-port",
    "43180",
    "--remote-ui-token=secret",
    "--remote-ui-host",
    "127.0.0.1",
  ]);
  assert.deepEqual(parsed, {
    enable: true,
    port: 43180,
    token: "secret",
    host: "127.0.0.1",
  });
});

test("parseRemoteUiCliArgs accepts password alias and disable flag", () => {
  const parsed = parseRemoteUiCliArgs(["--remote-ui-password", "pw", "--no-remote-ui"]);
  assert.equal(parsed.token, "pw");
  assert.equal(parsed.enable, false);
});

test("applyRemoteUiCliArgsToEnv forces enable when token is provided", () => {
  const env: NodeJS.ProcessEnv = {
    PI_APP_REMOTE_UI_PORT: "11111",
  };
  applyRemoteUiCliArgsToEnv(["--remote-ui-token", "abc", "--remote-ui-port=22222"], env);
  assert.equal(env.PI_APP_REMOTE_UI, "1");
  assert.equal(env.PI_APP_REMOTE_UI_TOKEN, "abc");
  assert.equal(env.PI_APP_REMOTE_UI_PORT, "22222");
});

test("applyRemoteUiCliArgsToEnv honors --no-remote-ui", () => {
  const env: NodeJS.ProcessEnv = {};
  applyRemoteUiCliArgsToEnv(["--no-remote-ui", "--remote-ui-token", "abc"], env);
  assert.equal(env.PI_APP_REMOTE_UI, "0");
  assert.equal(env.PI_APP_REMOTE_UI_TOKEN, "abc");
});
