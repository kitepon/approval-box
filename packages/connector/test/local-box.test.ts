// LocalBox (c8c): the server's connector routes answered on the PC, with the peer-channel transport faked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerError } from "../src/api.ts";
import { LocalBox } from "../src/local-box.ts";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "ab-localbox-"));
  const b = new LocalBox(join(dir, "decisions.json"));
  const sent: [string, ...unknown[]][] = [];
  let n = 0;
  b.transport = { request: (c, blobs) => { sent.push(["request", c, blobs]); return `rid${++n}`; }, amend: (rid, c) => { sent.push(["amend", rid, c]); }, cancel: (rid, r) => { sent.push(["cancel", rid, r]); } };
  const create = (extra: Record<string, unknown> = {}) => {
    const body = { title: "件名", context: "本文", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], session_label: "作業", client: "codex", route: { channel_id: "c1", harness: "codex" }, ...extra };
    const err = (() => { try { b.route("POST", "/decisions", body); } catch (e) { return e; } })() as ServerError;
    assert.equal(err.code, "confirm_required");
    return b.route("POST", "/decisions", { ...body, check_token: err.body.check_token }) as { decision_id: string; version: number };
  };
  return { b, sent, create, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const fails = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof ServerError && e.code === code);

test("amend sends the new content, a route-only change does not; version checks; cancel reaches the transport", () => {
  const x = box();
  try {
    const d = x.create();
    assert.equal(x.sent[0]![0], "request");
    fails(() => x.b.route("POST", `/decisions/${d.decision_id}/amend`, { version: 9, note: "n", changes: { title: "新" } }), "conflict");
    const a = x.b.route("POST", `/decisions/${d.decision_id}/amend`, { version: 1, note: "n", changes: { title: "新しい件名" } }) as { version: number; title: string };
    assert.deepEqual([a.version, a.title], [2, "新しい件名"]);
    assert.equal((x.sent[1]![2] as { title: string }).title, "新しい件名");
    const r = x.b.route("POST", `/decisions/${d.decision_id}/resume`, { channel_id: "c2", harness: "codex" }) as { this_session: boolean; version: number };
    assert.deepEqual([r.this_session, r.version, x.sent.length], [true, 3, 2]); // route only: nothing sent to the device
    x.b.route("POST", `/decisions/${d.decision_id}/cancel`, { reason: "要らない" });
    assert.deepEqual(x.sent[2], ["cancel", "rid1", "要らない"]);
    fails(() => x.b.route("POST", `/decisions/${d.decision_id}/cancel`, { reason: "again" }), "conflict");
  } finally { x.done(); }
});

test("duplicate titles, request images and attachments are refused with the server's codes", () => {
  const x = box();
  try {
    x.create({ title: "同じ件名" });
    fails(() => x.create({ title: "同じ  件名！" }), "duplicate_suspected");
    x.create({ title: "同じ件名", distinct_reason: "別件" });
    fails(() => x.create({ title: "画像", request_attachment_ids: ["unknown-upload"] }), "validation_failed"); // after the check, as on the server
    fails(() => x.b.route("GET", "/decisions/K-XXXXXX/attachments/a1"), "not_found");
  } finally { x.done(); }
});

test("an answer must be one of the request's options; expiry cancels; the setup test carries its code to the AI", () => {
  const x = box();
  try {
    const d = x.create();
    assert.equal(x.b.validAnswer("rid1", { option_id: "zzz" }), false);
    assert.equal(x.b.validAnswer("rid1", { option_id: "a", text: "ok", extra: 1 }), false);
    assert.equal(x.b.validAnswer("rid1", { text: "文だけ" }), true);
    x.b.answered("rid1", { option_id: "b" });
    const [item] = (x.b.route("GET", "/deliveries") as { items: { decision_id: string; text: string }[] }).items;
    assert.equal(item!.decision_id, d.decision_id);
    assert.match(item!.text, /答え: B（option_id=b）/);
    const e = x.create({ title: "期限" });
    x.b.expired("rid2");
    assert.equal((x.b.route("GET", `/decisions/${e.decision_id}`) as { status: string }).status, "cancelled");
    const t = x.b.route("POST", "/setup-test", { client: "codex", session_label: "接続テスト", route: { channel_id: "c1", harness: "codex" } }) as { decision_id: string; test: boolean };
    assert.equal(t.test, true);
    x.b.answered("rid3", { option_id: "ok" });
    const text = (x.b.route("GET", `/decisions/${t.decision_id}`) as { answer_text: string }).answer_text;
    const code = /確認コード: (\d{6})/.exec(text)![1]!;
    fails(() => x.b.route("POST", "/setup-test/confirm", { decision_id: t.decision_id, code: "000000" }), "validation_failed");
    assert.deepEqual(x.b.route("POST", "/setup-test/confirm", { decision_id: t.decision_id, code }), { status: "passed", client: "codex" });
  } finally { x.done(); }
});

test("request images travel as blobs and stay on the PC; answer attachments are delivered and downloadable; hold shows as held", async () => {
  const x = box();
  try {
    const root = (x.b as unknown as { root: string }).root;
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    mkdirSync(join(root, "uploads"), { recursive: true });
    writeFileSync(join(root, "uploads", "u1"), Buffer.from("png-bytes"));
    writeFileSync(join(root, "uploads", "u1.json"), JSON.stringify({ name: "a.png", content_type: "image/png" }));
    const d = x.create({ request_attachment_ids: ["u1"] }) as { decision_id: string; request_attachments: { id: string; name: string }[] };
    assert.deepEqual(d.request_attachments.map((a) => a.name), ["a.png"]);
    assert.ok(!existsSync(join(root, "uploads", "u1")), "the staged file is taken");
    const sentBlobs = x.sent.find(([k]) => k === "request")![2] as { name: string; bytes: Uint8Array }[];
    assert.equal(Buffer.from(sentBlobs[0]!.bytes).toString(), "png-bytes");
    assert.equal(x.b.download(`/decisions/${d.decision_id}/attachments/${d.request_attachments[0]!.id}`).toString(), "png-bytes");

    x.b.held("rid1", true);
    assert.equal((x.b.route("GET", `/decisions/${d.decision_id}`) as { status: string }).status, "held");
    assert.equal(x.b.validAnswer("rid1", {}, 0), false);
    assert.equal(x.b.validAnswer("rid1", {}, 1), true); // attachments alone answer
    x.b.answered("rid1", { text: "写真です" }, [{ meta: { name: "photo.jpg", content_type: "image/jpeg", size: 5 }, bytes: Buffer.from("jpeg!") }]);
    const [item] = (x.b.route("GET", "/deliveries") as { items: { text: string; attachments: { id: string; sha256: string }[] }[] }).items;
    assert.match(item!.text, /添付 1件/);
    assert.match(item!.text, /photo\.jpg（image\/jpeg、5B）/);
    assert.equal(x.b.download(`/decisions/${d.decision_id}/attachments/${item!.attachments[0]!.id}`).toString(), "jpeg!");
    assert.throws(() => x.b.download(`/decisions/${d.decision_id}/attachments/nope`), (e: unknown) => e instanceof ServerError && e.code === "not_found");
  } finally { x.done(); }
});
