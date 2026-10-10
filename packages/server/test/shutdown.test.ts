import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

function setup(shutdown?: AbortSignal) {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const decisions = new Decisions(db, events);
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test", ...(shutdown ? { shutdown } : {}) });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  return { app, events, userId, session };
}

/** 流れが閉じるまで読む。閉じなければ時間切れで落とす。 */
async function readToEnd(response: Response, timeoutMs = 2000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("流れが閉じませんでした")), timeoutMs).unref());
  for (;;) {
    const chunk = await Promise.race([reader.read(), deadline]);
    if (chunk.done) return text;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

test("停止の合図で、アプリ向けの更新の知らせを正しく閉じる", async () => {
  const stop = new AbortController();
  const ctx = setup(stop.signal);
  const response = await ctx.app.request("/v1/events", { headers: { authorization: `Bearer ${ctx.session}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  ctx.events.publish(ctx.userId, "decision.created", { decision_id: "K-TEST01" });
  setTimeout(() => stop.abort(), 50);
  const text = await readToEnd(response);
  // 停止の前に流したイベントは届き、流れは誤りなく終わる。
  assert.match(text, /event: decision\.created/);
});

test("停止の合図の後に来た接続も、待たせずに閉じる", async () => {
  const stop = new AbortController();
  stop.abort();
  const ctx = setup(stop.signal);
  const response = await ctx.app.request("/v1/events", { headers: { authorization: `Bearer ${ctx.session}` } });
  assert.equal(response.status, 200);
  assert.equal(await readToEnd(response), "");
});

test("停止の合図が無ければ、流れは開いたまま", async () => {
  const ctx = setup();
  const response = await ctx.app.request("/v1/events", { headers: { authorization: `Bearer ${ctx.session}` } });
  await assert.rejects(readToEnd(response, 300), /流れが閉じませんでした/);
  await response.body!.cancel().catch(() => {});
});
