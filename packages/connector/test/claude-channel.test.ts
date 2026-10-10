import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as steer from "aiterm-steer-delivery";
import { claudeChannelIsCurrent } from "../src/claude-channel.ts";
import { writeJsonFile } from "../src/config.ts";
import { PROFILE } from "../src/profile.ts";

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "ab-claude-channel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
  const hookRoot = join(root, "requests");
  const sessionId = randomUUID();
  /** PreToolUse hookが残す依頼の記録を作り、その依頼の親を返す。 */
  const request = (pid: number, started: string, session = sessionId) => {
    const requestId = randomUUID();
    writeJsonFile(join(hookRoot, requestId, "request.json"), { request_id: requestId, session_id: session, agent_id: null, parent_pid: pid, parent_started_identity: started });
    return { kind: "claude" as const, request_id: requestId, session_id: session, hook_root: hookRoot };
  };
  const alive = steer.readRuntimeProcesses().find(p => p.pid === process.pid)!.started_identity;
  return { profile, request, sessionId, alive };
}

test("同じ会話でも、Claudeのprocessが替わったら保存済みのchannelを使い回さない", t => {
  const x = setup(t);
  const before = x.request(process.pid, x.alive);
  const channel = steer.openChannel(x.profile, before);
  // 同じprocessからの次の依頼は、同じchannelを使う。
  assert.equal(claudeChannelIsCurrent(x.profile, channel.channel_id, x.request(process.pid, x.alive)), true);
  // アプリを起動し直した後: session_id は同じで、pid と開始時刻が違う。
  assert.equal(claudeChannelIsCurrent(x.profile, channel.channel_id, x.request(process.pid + 1, "2026-10-10T06:42:32.506Z")), false);
  // pid が再利用されても、開始時刻が違えば別のprocess。
  assert.equal(claudeChannelIsCurrent(x.profile, channel.channel_id, x.request(process.pid, "2026-10-10T06:42:32.506Z")), false);
  // 別の会話の依頼には使わない。
  assert.equal(claudeChannelIsCurrent(x.profile, channel.channel_id, x.request(process.pid, x.alive, randomUUID())), false);
  // 読めないchannelと、依頼の記録が無い親は、開き直させる。
  assert.equal(claudeChannelIsCurrent(x.profile, randomUUID(), before), false);
  assert.equal(claudeChannelIsCurrent(x.profile, channel.channel_id, { ...before, request_id: randomUUID() }), false);
});

test("古いprocessに結んだchannelだけでは待機が終わり、今のprocessのchannelを開くと古いchannelの答えも届く", async t => {
  const x = setup(t);
  // 起動し直す前のprocessに結んだchannel（そのprocessはもう居ない）。
  const stale = steer.openChannel(x.profile, x.request(999_999_999, "2026-10-10T04:20:11.627Z"));
  const deliveryId = randomUUID();
  await steer.sendToChannel(x.profile, stale.channel_id, deliveryId, "restart-answer");
  let out = "";
  const emit = (text: string) => { out += text; };
  // 2026-10-10 に fox で起きた形。待機はすぐ終わり、答えは受信箱に残る。
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, emit, { wait_ms: 300, poll_ms: 20 }), 0);
  assert.equal(out, "");
  assert.equal(steer.channelDeliveryState(x.profile, stale.channel_id, deliveryId), "queued");
  // 修理後: 次の依頼で、今のprocessに結んだchannelを開く（古いchannelは閉じない）。
  const now = x.request(process.pid, x.alive);
  assert.equal(claudeChannelIsCurrent(x.profile, stale.channel_id, now), false);
  steer.openChannel(x.profile, now);
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, emit, { wait_ms: 2000, poll_ms: 20 }), 2);
  assert.equal(out, "restart-answer");
  assert.equal(steer.channelDeliveryState(x.profile, stale.channel_id, deliveryId), "emitted");
});
