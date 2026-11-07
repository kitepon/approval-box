import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as steer from "aiterm-steer-delivery";
import { type Entry, abandoned, daemonNode, receiverOf, shouldReplaceDaemon, versionOfEntry } from "../src/daemon.ts";
import { writeJsonFile } from "../src/config.ts";
import { recordBackgroundReceiver } from "../src/background-receiver.ts";
import { PROFILE } from "../src/profile.ts";

const entry = (version: string) => `/home/u/.approval-box/runtime/${version}/cli.mjs`;

test("デーモンの入れ替え: 古い版は新しい版へ替えるが、新しい版を古い版へ戻さない", () => {
  assert.deepEqual(versionOfEntry(entry("0.1.10")), [0, 1, 10]);
  assert.deepEqual(versionOfEntry("C:\\Users\\u\\.approval-box\\runtime\\0.1.9\\cli.mjs"), [0, 1, 9]);
  assert.equal(versionOfEntry("/repo/packages/connector/dist/cli.mjs"), null);
  assert.equal(shouldReplaceDaemon(entry("0.1.10"), entry("0.1.10")), false);
  assert.equal(shouldReplaceDaemon(entry("0.1.9"), entry("0.1.10")), true);
  assert.equal(shouldReplaceDaemon(entry("0.1.10"), entry("0.1.9")), false);
  assert.equal(shouldReplaceDaemon(entry("0.2.0"), entry("0.1.11")), false);
  // 版が読めない置き場（開発中の dist）は、今までどおり自分へ入れ替える
  assert.equal(shouldReplaceDaemon("/repo/dist/cli.mjs", entry("0.1.10")), true);
  assert.equal(shouldReplaceDaemon(undefined, entry("0.1.10")), true);
});

test("配送デーモンを起こすnode: 更新で消える場所ではなく、今ある場所を引く", () => {
  const cellar = "/opt/homebrew/Cellar/node/26.10.0_1/bin/node", opt = "/opt/homebrew/opt/node/bin/node";
  // Homebrewの版つきの場所は、更新で実体が消えた後も、残る opt を引く
  assert.equal(daemonNode(cellar, file => file === opt), opt);
  assert.equal(daemonNode(cellar, file => file === opt || file === cellar), opt);
  // それ以外で実体があれば、そのまま使う
  assert.equal(daemonNode("/usr/bin/node", () => true), "/usr/bin/node");
  // 実体が消えていて代わりも無ければ、PATHから探させる
  assert.equal(daemonNode("/gone/bin/node", () => false), "node");
});

test("受け口の有無: 閉じた印、結んだprocess、起動し直した同じ会話の待機で決める", t => {
  const root = mkdtempSync(join(tmpdir(), "ab-daemon-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
  const hookRoot = join(root, "requests");
  const session = randomUUID();
  const requestId = randomUUID();
  writeJsonFile(join(hookRoot, requestId, "request.json"), { request_id: requestId, session_id: session, agent_id: null, parent_pid: 4242, parent_started_identity: "p" });
  const channel = steer.openChannel(profile, { kind: "claude", request_id: requestId, session_id: session, hook_root: hookRoot });
  const alive = new Set<string>();
  const running = (pid: number, id: string) => alive.has(`${pid}:${id}`);
  alive.add("4242:p");
  assert.equal(receiverOf(channel.channel_id, profile, running), "present");
  // 結んだprocessが印を書かずに終わった（Aitermの会話替え、強制終了）。2026-11-07 K-CNYUNZ の形。
  alive.clear();
  assert.equal(receiverOf(channel.channel_id, profile, running), "gone");
  // 起動し直した同じ会話のhookが待機している（processは別）なら、その待機が本文を出す。
  writeFileSync(join(steer.channelRoot(profile), "claude-sessions", session, "waiter.json"), JSON.stringify({ pid: 777, started_identity: "w" }));
  assert.equal(receiverOf(channel.channel_id, profile, running), "gone");
  alive.add("777:w");
  assert.equal(receiverOf(channel.channel_id, profile, running), "present");
  steer.closeChannel(profile, channel.channel_id);
  assert.equal(receiverOf(channel.channel_id, profile, running), "closed");
  // 背景channel（Grok等）は、AIが背景で起こした受信processが居る間だけ出せる。2026-11-07 K-7T8TZ2/K-YF7BB8 は受信が居ないまま12時間待った。
  const background = steer.openChannel(profile, null).channel_id;
  assert.equal(receiverOf(background, profile, running), "gone");
  assert.equal(recordBackgroundReceiver(background, profile, 999, "r"), true);
  assert.equal(receiverOf(background, profile, running), "gone");
  alive.add("999:r");
  assert.equal(receiverOf(background, profile, running), "present");
  assert.equal(recordBackgroundReceiver(background, profile, 1000, undefined), false);
  assert.equal(receiverOf(background, profile, running), "present");
  // 読めないchannelでも諦めない。
  assert.equal(receiverOf(randomUUID(), profile, running), "present");
});

test("諦める時機: 閉じた印は即、processが消えただけなら5分待ち、受け口が戻れば数え直す", () => {
  const entry: Entry = { delivery_id: "d", channel_id: "c", harness: "claude", state: "queued", at: "2026-11-07T11:29:18.000Z" };
  const t0 = Date.parse("2026-11-07T11:29:20.000Z");
  assert.equal(abandoned(entry, "closed", t0), true);
  assert.equal(abandoned(entry, "gone", t0), false);
  assert.equal(entry.orphaned_at, "2026-11-07T11:29:20.000Z");
  assert.equal(abandoned(entry, "gone", t0 + 4 * 60_000), false);
  assert.equal(abandoned(entry, "present", t0 + 4 * 60_000), false);
  assert.equal(entry.orphaned_at, undefined);
  assert.equal(abandoned(entry, "gone", t0 + 4 * 60_000), false);
  assert.equal(abandoned(entry, "gone", t0 + 9 * 60_000), true);
});
