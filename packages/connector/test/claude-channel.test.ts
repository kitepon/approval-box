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

test("Claudeが起動し直した後、古いprocessに結んだchannelの答えが、新しい申請を待たずに今のprocessへ届く", async t => {
  const x = setup(t);
  // 起動し直す前のprocessに結んだchannel（そのprocessはもう居ない）へ、止まっていた間の答えが届いた。
  const stale = steer.openChannel(x.profile, x.request(999_999_999, "2026-10-10T04:20:11.627Z"));
  const deliveryId = randomUUID();
  await steer.sendToChannel(x.profile, stale.channel_id, deliveryId, "restart-answer");
  let out = "";
  const emit = (text: string) => { out += text; };
  const wait = { wait_ms: 300, poll_ms: 20 };
  // hookを起こしたprocessが居ない時は、本文を取らずに終わる（取ると、出す先が無くて失う）。
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, emit, { ...wait, owner: { pid: 999_999_998, started_identity: "2026-10-10T04:20:11.627Z" } }), 0);
  // hookを起こしたprocessを確かめられない時は、channelを開いたprocessで決める。0.4.1 までの動きで、2026-10-10 に fox で起きた形。
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, emit, { ...wait, owner: null }), 0);
  assert.equal(out, "");
  assert.equal(steer.channelDeliveryState(x.profile, stale.channel_id, deliveryId), "queued");
  // 再開した会話のhook（今のprocess）は、同じ会話の古いchannelの答えを引き取る。新しい申請は要らない。
  const owner = { pid: process.pid, started_identity: x.alive };
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, emit, { ...wait, owner }), 2);
  assert.equal(out, "restart-answer");
  assert.equal(steer.channelDeliveryState(x.profile, stale.channel_id, deliveryId), "emitted");
});

test("起動し直した後の新しい申請は今のprocessのchannelを開き、古いchannelの答えと届いた順に出る", async t => {
  const x = setup(t);
  const stale = steer.openChannel(x.profile, x.request(999_999_999, "2026-10-10T04:20:11.627Z"));
  const now = x.request(process.pid, x.alive);
  // コネクタは、古いprocessに結んだchannelを使い回さず、開き直す。古いchannelは閉じない。
  assert.equal(claudeChannelIsCurrent(x.profile, stale.channel_id, now), false);
  const current = steer.openChannel(x.profile, now);
  assert.equal(steer.channelClosed(x.profile, stale.channel_id), false);
  const first = randomUUID(), second = randomUUID();
  await steer.sendToChannel(x.profile, stale.channel_id, first, "before-restart");
  await new Promise(resolve => setTimeout(resolve, 5));
  await steer.sendToChannel(x.profile, current.channel_id, second, "after-restart");
  let out = "";
  const owner = { pid: process.pid, started_identity: x.alive };
  assert.equal(await steer.runClaudeChannelWaiter(x.profile, { session_id: x.sessionId }, text => { out += text; }, { wait_ms: 2000, poll_ms: 20, owner }), 2);
  assert.equal(out, "before-restart\n\nafter-restart");
  assert.equal(steer.channelDeliveryState(x.profile, stale.channel_id, first), "emitted");
  assert.equal(steer.channelDeliveryState(x.profile, current.channel_id, second), "emitted");
});
