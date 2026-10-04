import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openChannel, sendToChannel, channelMarker, channelRoot, channelDeliveryState, receiveFromChannel } from "aiterm-steer-delivery";
import { PROFILE } from "../src/profile.ts";
import { bindCursorResult } from "../src/cursor-binding.ts";

for (const order of ["hook-first", "receiver-first", "receiver-waiting"] as const) {
  test(`Cursor: ${order}でもhookは消費せず、背景受信が回答を一度だけ出す`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ab-cursor-bind-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
    const channel = openChannel(profile, { kind: "cursor" });
    const id = channel.channel_id;
    const marker = channelMarker(channel).text;
    const deliveryId = randomUUID();
    const dir = join(channelRoot(profile), id);
    const event = { conversation_id: "test-conversation", hook_event_name: "postToolUse",
      tool_name: "MCP:request_decision", tool_output: marker };
    await bindCursorResult(profile, JSON.stringify(event));
    assert.equal(JSON.parse(readFileSync(join(dir, "bind.json"), "utf8")).conversation_id, event.conversation_id);
    const output: unknown[] = [];
    const receive = () => receiveFromChannel(profile, id, { wait_ms: 1000, poll_ms: 1, emit: value => { output.push(value); } });
    const waiting = order === "receiver-waiting" ? receive() : null;
    await sendToChannel(profile, id, deliveryId, "answer text");
    let result;
    if (order === "receiver-first") result = await receive();
    // 本番の失敗条件: 端末を読むReadのhookが、回答到着後に繰り返し起動する。
    for (let i = 0; i < 5; i++) await bindCursorResult(profile, JSON.stringify({ ...event, tool_name: "Read", tool_output: "terminal output" }));
    if (order !== "receiver-first") {
      assert.equal(channelDeliveryState(profile, id, deliveryId), "queued");
      assert.equal(readdirSync(join(dir, "emitted")).length, 0);
      result = await (waiting ?? receive());
    }
    assert.equal(result!.outcome, "delivered");
    assert.equal(output.length, 1);
    assert.deepEqual((result as { deliveries: unknown[] }).deliveries, [{ delivery_id: deliveryId, text: "answer text" }]);
    assert.equal(channelDeliveryState(profile, id, deliveryId), "emitted");
    assert.equal(JSON.parse(readFileSync(join(dir, "emitted", `${deliveryId}.json`), "utf8")).by, "receiver");
    assert.equal((await receiveFromChannel(profile, id, { wait_ms: 0 })).outcome, "timeout");
    // 同じ会話の次の回答も、hookを挟んで張り直したreceiveへ届く。
    const secondId = randomUUID();
    await sendToChannel(profile, id, secondId, "second answer");
    await bindCursorResult(profile, JSON.stringify(event));
    const second = await receiveFromChannel(profile, id, { wait_ms: 0 });
    assert.equal(second.outcome, "delivered");
    assert.deepEqual((second as { deliveries: unknown[] }).deliveries, [{ delivery_id: secondId, text: "second answer" }]);
  });
}

test("Cursor: BOM・afterMCPExecutionを受け、別の会話へbindを上書きしない", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ab-cursor-bind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
  const channel = openChannel(profile, { kind: "cursor" });
  const event = { hook_event_name: "afterMCPExecution", conversation_id: "first-conversation", tool_name: "request_decision", result_json: channelMarker(channel).text };
  await bindCursorResult(profile, "\uFEFF" + JSON.stringify(event));
  await bindCursorResult(profile, JSON.stringify({ ...event, conversation_id: "other-conversation" }));
  assert.equal(JSON.parse(readFileSync(join(channelRoot(profile), channel.channel_id, "bind.json"), "utf8")).conversation_id, "first-conversation");
  for (const input of ["invalid", "null", "[]", "{}", JSON.stringify({ ...event, hook_event_name: "sessionStart" })]) await bindCursorResult(profile, input);
});
