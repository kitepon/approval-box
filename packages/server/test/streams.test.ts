import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { SSEStreamingApi } from "hono/streaming";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

for (const kind of ["user", "connection"] as const) {
  for (const ending of ["write-error", "abort", "shutdown", "already-stopped"] as const) {
    test(`${kind} SSE: ${ending}で購読と停止listenerを解放する`, async t => {
      const db = openDb(":memory:"); t.after(() => db.close());
      const events = new EventHub(db), accounts = new Accounts(db, events, "off");
      const stop = new AbortController();
      let subscriptions = 0;
      const method = kind === "user" ? "subscribe" : "subscribeConnection";
      const original = events[method].bind(events);
      t.mock.method(events, method, (...args: unknown[]) => {
        const unsubscribe = (original as Function)(...args); let active = true;
        subscriptions++;
        return () => { if (active) { active = false; subscriptions--; } unsubscribe(); };
      });
      if (ending === "write-error") {
        t.mock.method(SSEStreamingApi.prototype, "writeSSE", async () => { throw new Error("isolated write failure"); });
        t.mock.method(console, "error", () => {});
      }
      const user = accounts.createUser();
      const { session } = accounts.issueSession(user, "test");
      const { token } = accounts.createConnection(user, "test", "linux", ["codex"]);
      events.publish(user, "decision.created", { decision_id: "K-TEST" });
      const app = createApp({ db, accounts, events, decisions: new Decisions(db, events), publicUrl: "https://test.invalid", shutdown: stop.signal });
      if (ending === "already-stopped") stop.abort();
      const response = await app.request(kind === "user" ? "/v1/events" : "/connector/v1/stream", { headers: { authorization: `Bearer ${kind === "user" ? session : token}` } });
      if (ending === "abort") await response.body!.cancel();
      else {
        const text = response.text();
        if (ending === "shutdown") stop.abort();
        await text;
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(subscriptions, 0);
      assert.equal(getEventListeners(stop.signal, "abort").length, 0);
    });
  }
}
