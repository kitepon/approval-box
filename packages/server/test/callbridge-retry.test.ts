import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callBridgeSender } from "../src/callbridge.ts";

const transient = { ok: false, error: "target_not_found", code: "directory_link_down", retryable: true, retry_after_seconds: 30, session_created: false };
for (const [name, opened, expected] of [
  ["未開設が保証された一時切断", transient, "retry"],
  ["旧文面だけの失敗", { ok: false, error: "target_not_found", detail: "Retry in about 30 seconds." }, "failed"],
  ["未開設の保証なし", { ...transient, session_created: undefined }, "failed"],
  ["通話IDが存在", { ...transient, session_id: "existing" }, "failed"],
] as const) test(`call_open: ${name}`, async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => { calls.push(name); return { structuredContent: opened, content: [], isError: true }; });
  const send = callBridgeSender({ url: "https://bridge.test/mcp", headers: {}, localSystem: "local", localId: "approval-box", localLabel: "Approval Box", memberSystem: "grokbot" });
  assert.equal((await send("actor", "K-TEST", "answer")).state, expected);
  assert.deepEqual(calls, ["call_open"]);
});

test("call_send後のunknownや通信例外へ再試行保証を広げない", async t => {
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  const calls: string[] = [];
  t.mock.method(Client.prototype, "callTool", async ({ name }: { name: string }) => { calls.push(name); if (name === "call_open") return { structuredContent: { session_id: "new" }, content: [] }; if (name === "call_send") throw new Error("response lost"); return { content: [] }; });
  const send = callBridgeSender({ url: "https://bridge.test/mcp", headers: {}, localSystem: "local", localId: "approval-box", localLabel: "Approval Box", memberSystem: "grokbot" });
  assert.equal((await send("actor", "K-TEST", "answer")).state, "unknown");
  assert.deepEqual(calls, ["call_open", "call_send"]);
});
