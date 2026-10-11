import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as steer from "aiterm-steer-delivery";
import { PROFILE } from "../src/profile.ts";
import { sendChannelAnswer, channelAnswerState, type CodexProvider } from "../src/channel-delivery.ts";
import { writeJsonFile } from "../src/config.ts";

test("旧Codex channel.v1を改変せず共通providerへ渡し、unknownを二重配送しない", async t => {
  const root = mkdtempSync(join(tmpdir(), "ab-old-channel-"));
  const saved = process.env.APPROVAL_BOX_HOME; process.env.APPROVAL_BOX_HOME = root;
  t.after(() => { if (saved === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = saved; rmSync(root, { recursive: true, force: true }); });
  const channelId = randomUUID(), deliveryId = randomUUID();
  const parent = { thread_id: randomUUID(), codex_home: join(root, "legacy-home") };
  // 0.1.17が保存した形式。新openChannelで作り直さず互換性を確かめる。
  const file = join(steer.channelRoot(PROFILE), channelId, "channel.json");
  writeJsonFile(file, { schema: "aiterm-steer.channel.v1", channel_id: channelId, kind: "codex", created_at: "2026-10-06T23:00:00Z", codex: parent });
  const before = readFileSync(file, "utf8");
  const calls: unknown[] = [];
  const codex: CodexProvider = {
    submit: async (p, id, text) => { calls.push([p, id, text]); return { queued_submission_id: "official-queue-id" }; },
    state: async (p, id) => { assert.deepEqual(p, parent); assert.equal(id, deliveryId); return "sending"; },
  };
  assert.deepEqual(await sendChannelAnswer(channelId, deliveryId, "answer", codex), { state: "submitted", queued_submission_id: "official-queue-id" });
  assert.deepEqual(calls, [[parent, deliveryId, "answer"]]);
  assert.equal(await channelAnswerState(channelId, deliveryId, codex), "sending");
  const unknown = new steer.CodexDeliveryError("AITERM_PROVIDER_UNAVAILABLE", "submitの受付不明", true);
  await assert.rejects(sendChannelAnswer(channelId, randomUUID(), "next", { ...codex, submit: async () => { throw unknown; } }), error => error === unknown);
  assert.equal(readFileSync(file, "utf8"), before);
  steer.closeChannel(PROFILE, channelId);
  await assert.rejects(sendChannelAnswer(channelId, randomUUID(), "closed", codex), /会話が終わっています/);
  assert.equal(calls.length, 1);
});

test("Codex以外のchannelは既存配送を維持する", async t => {
  const root = mkdtempSync(join(tmpdir(), "ab-background-provider-"));
  const saved = process.env.APPROVAL_BOX_HOME; process.env.APPROVAL_BOX_HOME = root;
  t.after(() => { if (saved === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = saved; rmSync(root, { recursive: true, force: true }); });
  const channel = steer.openChannel(PROFILE, null), id = randomUUID();
  const codex: CodexProvider = { submit: async () => assert.fail("Codex providerは呼ばない"), state: async () => assert.fail("Codex providerは呼ばない") };
  assert.equal((await sendChannelAnswer(channel.channel_id, id, "background answer", codex)).state, "queued");
  assert.equal(await channelAnswerState(channel.channel_id, id, codex), "queued");
  const received = await steer.receiveFromChannel(PROFILE, channel.channel_id, { wait_ms: 0 });
  assert.equal(received.outcome, "delivered");
});

test("同じchannelへ同じ配送IDで送り直しても本文は1通で、前の本文の行方を返す", async t => {
  const root = mkdtempSync(join(tmpdir(), "ab-duplicate-send-"));
  const saved = process.env.APPROVAL_BOX_HOME; process.env.APPROVAL_BOX_HOME = root;
  t.after(() => { if (saved === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = saved; rmSync(root, { recursive: true, force: true }); });
  const channel = steer.openChannel(PROFILE, null), id = randomUUID();
  assert.equal((await sendChannelAnswer(channel.channel_id, id, "answer")).state, "queued");
  // 前の本文がまだ受信箱にある。失敗として返さず、待ちとして扱う。
  assert.equal((await sendChannelAnswer(channel.channel_id, id, "answer")).state, "queued");
  assert.equal(await channelAnswerState(channel.channel_id, id), "queued");
  const received = await steer.receiveFromChannel(PROFILE, channel.channel_id, { wait_ms: 0 });
  assert.deepEqual(received.outcome === "delivered" && received.deliveries.map(d => d.delivery_id), [id]);
  // 会話へ出た後の送り直しも足さない。デーモンは emitted を見て delivered と報告する。
  assert.equal((await sendChannelAnswer(channel.channel_id, id, "answer")).state, "queued");
  assert.equal(await channelAnswerState(channel.channel_id, id), "emitted");
  assert.equal((await steer.receiveFromChannel(PROFILE, channel.channel_id, { wait_ms: 0 })).outcome, "timeout");

  // 取り下げた配送IDを同じchannelへ送り直す形は、今までどおり断る。
  const withdrawn = randomUUID();
  await sendChannelAnswer(channel.channel_id, withdrawn, "moved");
  assert.equal(steer.withdrawFromChannel(PROFILE, channel.channel_id, withdrawn), true);
  await assert.rejects(sendChannelAnswer(channel.channel_id, withdrawn, "moved"), /CHANNEL_DELIVERY_DUPLICATE/);
  assert.equal((await steer.receiveFromChannel(PROFILE, channel.channel_id, { wait_ms: 0 })).outcome, "timeout");
});
