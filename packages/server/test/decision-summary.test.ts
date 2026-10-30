import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

test("接続内の一覧・確認・重複候補は要約だけ、本文は明示取得で返す", async t => {
  const db = openDb(":memory:");
  t.after(() => db.close());
  const events = new EventHub(db), accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://test.invalid" });
  const user = accounts.createUser();
  const { session } = accounts.issueSession(user, "owner");
  const { token } = accounts.createConnection(user, "shared", "linux", ["codex"]);
  const other = accounts.createConnection(user, "other", "linux", ["codex"]);
  const call = async (method: string, path: string, auth: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const input = { title: "shared title", context: "synthetic-private-context", options: [{ id: "ok", label: "synthetic-private-option" }, { id: "no", label: "later" }],
    client: "codex", session_label: "work", requester: "A", route: { channel_id: "thread-a", harness: "codex" } };
  const create = async (body: typeof input) => {
    const check = await call("POST", "/connector/v1/decisions", token, body);
    assert.equal(check.body.error.code, "confirm_required");
    const created = await call("POST", "/connector/v1/decisions", token, { ...body, check_token: check.body.error.check_token });
    assert.equal(created.status, 200);
    return created.body;
  };
  const answered = await create(input);
  assert.equal((await call("POST", `/v1/decisions/${answered.decision_id}/answer`, session,
    { option_id: "ok", text: "synthetic-private-answer", version: answered.version })).status, 200);
  const pending = await create(input);
  const b = { ...input, requester: "B", route: { channel_id: "thread-b", harness: "codex" } };
  const listed = await call("GET", "/connector/v1/decisions?channel_id=thread-b", token);
  const check = await call("POST", "/connector/v1/decisions", token, b);
  const duplicate = await call("POST", "/connector/v1/decisions", token, { ...b, check_token: check.body.error.check_token });
  assert.equal(duplicate.body.error.code, "duplicate_suspected");
  for (const items of [listed.body.items, check.body.error.decisions, duplicate.body.error.existing]) {
    assert(items.length > 0);
    for (const item of items) {
      assert.equal(item.title, input.title);
      assert.equal(item.requester, "A");
      for (const key of ["context", "options", "recommendation", "request_attachments", "answer", "answer_text", "cancel_reason"])
        assert.equal(key in item, false, key);
    }
    assert.doesNotMatch(JSON.stringify(items), /synthetic-private-/);
  }
  assert.equal(listed.body.items.find((x: { decision_id: string }) => x.decision_id === answered.decision_id).has_answer, true);
  assert.equal(listed.body.items.find((x: { decision_id: string }) => x.decision_id === pending.decision_id).has_answer, false);
  const detail = await call("GET", `/connector/v1/decisions/${answered.decision_id}`, token);
  assert.equal(detail.body.answer.text, "synthetic-private-answer");
  assert.match(detail.body.answer_text, /synthetic-private-answer/);
  assert.deepEqual((await call("GET", "/connector/v1/decisions", other.token)).body.items, []);
  assert.equal((await call("GET", `/connector/v1/decisions/${answered.decision_id}`, other.token)).status, 404);
});
