import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_CHECK, BELLTEAM_MCP_URL, bellteamBotId, queueWake, rememberRequester, requesterOf, sendWake, wakeMessage, type Wakes } from "../src/bellteam-wake.ts";

const bt = (seat?: string) => ({ BELLTEAM_ROOT: "/srv/bellteam", AITERM_SESSION_ID: seat }) as NodeJS.ProcessEnv;

test("BellTeamの席のBot ID: 別アカウントの接尾辞は外し、フォークの席と他の席は除く", () => {
  assert.equal(bellteamBotId(bt("bot-4366a50b")), "bot-4366a50b");
  assert.equal(bellteamBotId(bt("bot-39be7047-1st-mwc5iito")), "bot-39be7047");
  assert.equal(bellteamBotId(bt("bot-4366a50b-fork-0123456789ab")), null);
  assert.equal(bellteamBotId({ AITERM_SESSION_ID: "bot-4366a50b" }), null);
  assert.equal(bellteamBotId(bt("codex-main")), null);
  assert.equal(bellteamBotId(bt(undefined)), null);
});

test("申請元の控え: BellTeam以外は何も書かず、BellTeamなら一件だけ積む", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-wake-"));
  const saved = process.env.APPROVAL_BOX_HOME;
  process.env.APPROVAL_BOX_HOME = home;
  try {
    const wakes: Wakes = {};
    rememberRequester("ch-plain", {});
    assert.equal(requesterOf("ch-plain"), null);
    assert.equal(queueWake(wakes, "K-1", "ch-plain"), false);
    rememberRequester("ch-bt", bt("bot-4366a50b"));
    assert.equal(requesterOf("ch-bt"), "bot-4366a50b");
    assert.equal(queueWake(wakes, "K-1", "ch-bt"), true);
    assert.deepEqual(wakes["K-1"], { bot_id: "bot-4366a50b", state: "pending", tries: 0 });
    assert.equal(queueWake(wakes, "K-1", "ch-bt"), false);
    assert.equal(queueWake(wakes, "K-2", "ch-unknown"), false);
  } finally {
    if (saved === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("起こしの文: 申請IDと件名を載せ、答えの中身は載せない", () => {
  const text = wakeMessage("K-ABC123", "公開してよいか");
  assert.ok(text.includes("K-ABC123") && text.includes("公開してよいか") && text.includes("resume_decision"));
  assert.ok(!text.includes("答え:"));
});

const reply = (delivery: unknown) => ({ jsonrpc: "2.0", id: "x", result: { content: [{ type: "text", text: JSON.stringify(delivery) }] } });
const ok = { delivery: "steered", delivery_id: "d1", from: "bot-a1", target: "bot-a1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("BellTeamへの送信: 受け付けられたら accepted、送った内容を確かめる", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const result = await sendWake("bot-a1", wakeMessage("K-ABC123", "件名"), async (url, init) => { seen = { url: String(url), init: init! }; return json(reply(ok)); });
  assert.deepEqual(result, { outcome: "accepted", detail: "steered d1" });
  assert.equal(seen!.url, BELLTEAM_MCP_URL);
  assert.equal((seen!.init.headers as Record<string, string>)["X-Bellteam-Seat"], "bot-a1");
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.params.name, "sendmessage");
  assert.equal(body.params.arguments.target, "bot-a1");
  assert.ok(body.params.arguments.message.includes("resume_decision") && body.params.arguments.message.includes("K-ABC123"));
});

test("BellTeamへの送信: 断られたら refused、届く前の接続失敗だけ retry、結果不明は unknown", async () => {
  assert.equal((await sendWake("bot-a1", "m", async () => json({ jsonrpc: "2.0", id: "x", result: { isError: true, content: [{ type: "text", text: "BOT_NOT_FOUND" }] } }))).outcome, "refused");
  assert.equal((await sendWake("bot-a1", "m", async () => json({ jsonrpc: "2.0", id: "x", error: { message: "nope" } }))).outcome, "refused");
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
  assert.deepEqual(await sendWake("bot-a1", "m", async () => { throw refused; }), { outcome: "retry", detail: "ECONNREFUSED" });
  assert.equal((await sendWake("bot-a1", "m", async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); })).outcome, "unknown");
  assert.equal((await sendWake("bot-a1", "m", async () => new Response("", { status: 500 }))).outcome, "unknown");
  assert.deepEqual(await sendWake("bot-a1", "m", async () => json(reply({ delivery: "queued", delivery_id: "q1" }))), { outcome: "accepted", detail: "queued q1" });
});

test("BellTeamへの送信: SSE形式の返事も読む", async () => {
  const body = `event: message\ndata: ${JSON.stringify(reply(ok))}\n\n`;
  const result = await sendWake("bot-a1", "m", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(result.outcome, "accepted");
});

test("sendmessage の2段階: OWNER_CHECK の拒否だけ同じ呼び出しを一度だけ送り直す。ほかの拒否は送り直さない", async () => {
  const reply = (text: string, isError: boolean) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { isError, content: [{ type: "text", text }] } }), { headers: { "content-type": "application/json" } });
  const bodies: string[] = [];
  let n = 0;
  const gated = (async (_u: unknown, init?: RequestInit) => { bodies.push(String(init?.body)); return ++n === 1 ? reply(`${OWNER_CHECK}: judge the target first`, true) : reply(JSON.stringify({ delivery: "queued", delivery_id: "d1" }), false); }) as typeof fetch;
  assert.deepEqual(await sendWake("bot-x", "hi", gated), { outcome: "accepted", detail: "queued d1" });
  assert.equal(bodies.length, 2);
  assert.equal(JSON.parse(bodies[0]!).params.arguments.target, JSON.parse(bodies[1]!).params.arguments.target);
  let m = 0;
  const always = (async () => { m++; return reply(`${OWNER_CHECK}: again`, true); }) as typeof fetch;
  assert.equal((await sendWake("bot-x", "hi", always)).outcome, "refused");
  assert.equal(m, 2, "one retry only");
  let k = 0;
  const other = (async () => { k++; return reply("target_not_found", true); }) as typeof fetch;
  assert.equal((await sendWake("bot-x", "hi", other)).outcome, "refused");
  assert.equal(k, 1, "other refusals are not retried");
});
