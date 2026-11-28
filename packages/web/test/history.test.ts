import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type HistoryStore, type Kept } from "../src/history.ts";
import type { Attachment, Decision } from "../src/types.ts";

class MemoryStore implements HistoryStore {
  readonly kept = new Map<string, Kept>();
  async all() { return [...this.kept.values()]; }
  async get(id: string) { return this.kept.get(id); }
  async put(k: Kept) { this.kept.set(k.id, { ...k, files: { ...k.files } }); }
  async delete(ids: string[]) { for (const id of ids) this.kept.delete(id); }
}

const decision = (id: string, status: string, updated = "2026-11-28T00:00:00.000Z", extra: Partial<Decision> = {}): Decision => ({
  id, title: `title ${id}`, context: "c", options: [{ id: "a", label: "A" }], urgency: "normal",
  source: { client: "codex", session_label: "s", via: "connector" }, status, resume_phrase: "r", history: [], created_at: updated, updated_at: updated, version: 1, ...extra,
});
const tombstone = (id: string, extra: Partial<Decision> = {}): Decision => decision(id, "answered", undefined, { title: "", context: "", options: [], history: [], content_removed: true, version: 2, ...extra });
const attachment = (id: string): Attachment => ({ id, name: `${id}.png`, content_type: "image/png", kind: "image", size: 3, sha256: "x", created_at: "2026-11-28T00:00:00.000Z" });
const fail = (status: number, extra: object = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

/** A fake server and clock: every call is logged with the fake time it was made at. */
function setup(o: { entry?: () => string } = {}) {
  let t = Date.parse("2026-11-28T12:00:00.000Z");
  const s = {
    closed: [] as Decision[], views: new Map<string, Decision | 404>(), files: new Map<string, Blob | number>(), stored: [] as string[],
    settings: 30, offline: false, storedFails: false, limitAfter: Infinity, retryAfterMs: 30_000 as number | undefined, calls: [] as { at: number; what: string }[],
  };
  const hit = (what: string) => {
    if (s.offline) throw fail(0);
    s.calls.push({ at: t, what });
    if (s.calls.length > s.limitAfter) throw fail(429, s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs });
  };
  const call = async <T,>(method: string, path: string): Promise<T> => {
    hit(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/decisions?status=answered,cancelled")) return { items: s.closed } as T;
    if (method === "GET" && path === "/me/settings") return { retention_days: s.settings } as T;
    const stored = /^\/decisions\/([^/]+)\/stored$/.exec(path);
    if (method === "POST" && stored) { if (s.storedFails) throw fail(503); s.stored.push(decodeURIComponent(stored[1]!)); return { stored: true } as T; }
    const one = /^\/decisions\/([^/?]+)$/.exec(path);
    if (method === "GET" && one) { const v = s.views.get(decodeURIComponent(one[1]!)); if (!v || v === 404) throw fail(404); return v as T; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const fetchFile = async (decisionId: string, attachmentId: string) => {
    hit(`FILE ${decisionId}/${attachmentId}`);
    const f = s.files.get(attachmentId);
    if (f === undefined) throw fail(404);
    if (typeof f === "number") throw fail(f);
    return f;
  };
  const store = new MemoryStore();
  let changes = 0;
  const h = createHistory({ store, call, fetchFile, entry: o.entry ?? (() => "E1"), onChange: () => { changes++; }, now: () => t, sleep: async (ms) => { t += ms; } });
  return { s, h, store, advance: (ms: number) => { t += ms; }, changes: () => changes };
}

test("history: the back-fill keeps decided requests newest first and acks each once; open ones and tombstones are not kept; list shows the copies", async () => {
  const { s, h, store } = setup();
  s.closed = [decision("K-1", "answered", "2026-11-28T01:00:00.000Z"), decision("K-2", "cancelled", "2026-11-28T02:00:00.000Z")];
  await h.sync();
  assert.deepEqual(s.stored, ["K-2", "K-1"]);
  assert.deepEqual((await h.list()).map((d) => d.id), ["K-2", "K-1"]);
  await h.sync();
  assert.deepEqual(s.stored, ["K-2", "K-1"], "an acked request is not acked again");
  await h.keep(decision("K-3", "pending"));
  await h.keep(tombstone("K-4"));
  assert.equal(store.kept.has("K-3") || store.kept.has("K-4"), false);
});

test("history pacing: at most one call every 500 ms (2 a second, under 240 a minute); a 429 stops the pass until Retry-After and the next pass resumes where it stopped", async () => {
  const { s, h, advance } = setup();
  s.closed = Array.from({ length: 6 }, (_, i) => decision(`K-${i}`, "answered", `2026-11-28T0${i}:00:00.000Z`));
  s.limitAfter = 3; // the list and two acks pass, the third ack is refused 429 with Retry-After 30 s
  await h.sync();
  assert.deepEqual(s.stored, ["K-5", "K-4"], "newest first");
  const gaps = s.calls.slice(1).map((c, i) => c.at - s.calls[i]!.at);
  assert.ok(gaps.every((g) => g >= 500), `gaps ${gaps}`);
  assert.equal(s.calls.length, 4, "nothing retried after the 429");
  // Before Retry-After nothing is sent at all.
  s.limitAfter = Infinity;
  advance(10_000);
  await h.sync();
  assert.equal(s.calls.length, 4);
  // After it, the next pass skips what is stored and goes on.
  advance(20_001);
  await h.sync();
  assert.deepEqual(s.stored, ["K-5", "K-4", "K-3", "K-2", "K-1", "K-0"]);
  for (const id of ["K-5", "K-4"]) assert.equal(s.calls.filter((c) => c.what === `POST /decisions/${id}/stored`).length, 1, `${id} is not acked again`);
  const all = s.calls.slice(4);
  assert.ok(all.slice(1).every((c, i) => c.at - all[i]!.at >= 500));
  // No Retry-After: a 429 pauses for 60 s.
  s.closed.push(decision("K-9", "answered", "2026-11-29T00:00:00.000Z"));
  s.limitAfter = s.calls.length + 1;
  s.retryAfterMs = undefined;
  await h.sync();
  const n = s.calls.length;
  s.limitAfter = Infinity;
  advance(59_000); await h.sync(); assert.equal(s.calls.length, n);
  advance(2_000); await h.sync(); assert.ok(s.stored.includes("K-9"));
});

test("history attachments: the request's and the answer's files are saved with the copy before stored; a failed file is retried next load and holds back stored", async () => {
  const { s, h, store } = setup();
  const d = decision("K-1", "answered", undefined, { request_attachments: [attachment("r1")], answer: { option_id: "a", attachments: [attachment("a1")], answered_at: "2026-11-28T00:00:00.000Z" } });
  s.closed = [d];
  s.files.set("r1", new Blob(["req"]));
  s.files.set("a1", 503);
  await h.sync();
  assert.deepEqual(s.stored, [], "no stored while a file is missing");
  assert.equal(await (await h.file("K-1", "r1"))!.text(), "req");
  assert.equal(await h.file("K-1", "a1"), undefined);
  s.files.set("a1", new Blob(["ans"]));
  await h.sync();
  assert.deepEqual(s.stored, ["K-1"]);
  assert.equal(s.calls.filter((c) => c.what === "FILE K-1/r1").length, 1, "a saved file is not fetched again");
  // After the purge the files come from the copy here.
  s.closed = [];
  s.files.clear();
  s.views.set("K-1", tombstone("K-1", { delivery: "fetched" }));
  const shown = await h.view("K-1");
  assert.equal(shown.title, "title K-1");
  assert.equal(await (await h.file("K-1", "a1"))!.text(), "ans");
  assert.equal(store.kept.get("K-1")!.stored, true);
});

test("history: a file the server no longer has (404) because the request was purged ends the retries without stored; a 404 of a live request is retried", async () => {
  const { s, h, store } = setup();
  s.closed = [decision("K-1", "answered", undefined, { request_attachments: [attachment("r1")] })];
  s.views.set("K-1", s.closed[0]!);
  await h.sync(); // r1 404, the request still has its content: retried later
  assert.equal(store.kept.get("K-1")!.stored, false);
  s.closed = [];
  s.views.set("K-1", tombstone("K-1"));
  await h.sync();
  assert.equal(store.kept.get("K-1")!.stored, true);
  assert.deepEqual(s.stored, []);
  const before = s.calls.length;
  await h.sync();
  assert.equal(s.calls.length, before + 1, "only the list call: nothing is retried any more");
});

test("history d01: a tombstone or the content_removed event brings the delivery state into the copy; a 404 or offline shows the copy; no copy shows the tombstone", async () => {
  const { s, h, store } = setup();
  s.views.set("K-1", decision("K-1", "answered", undefined, { delivery: "waiting", answer: { option_id: "a", answered_at: "2026-11-28T00:00:00.000Z" } }));
  assert.equal((await h.view("K-1")).delivery, "waiting");
  await h.sync();
  assert.ok(store.kept.has("K-1"));
  await h.onEvent("decision.updated", { decision_id: "K-1", change: "content_removed", delivery: "delivered" });
  assert.equal(store.kept.get("K-1")!.decision.delivery, "delivered");
  s.views.set("K-1", tombstone("K-1", { delivery: "fetched" }));
  const shown = await h.view("K-1");
  assert.deepEqual([shown.title, shown.delivery, shown.answer?.option_id, shown.content_removed], ["title K-1", "fetched", "a", undefined]);
  assert.equal(store.kept.get("K-1")!.decision.delivery, "fetched", "kept with the copy");
  s.views.set("K-1", 404);
  assert.equal((await h.view("K-1")).title, "title K-1");
  s.offline = true;
  assert.equal((await h.view("K-1")).title, "title K-1", "offline: the copy here");
  s.offline = false;
  s.views.set("K-9", tombstone("K-9"));
  assert.equal((await h.view("K-9")).content_removed, true);
  await assert.rejects(h.view("K-404"), (e: { status?: number }) => e.status === 404);
});

test("history: a decided event fetches and keeps the request; retention and another account's copies are dropped; clear and clearAll", async () => {
  let entry = "E1";
  const { s, h, store, advance } = setup({ entry: () => entry });
  advance(-12 * 3600_000); // 2026-11-28T00:00
  s.views.set("K-1", decision("K-1", "answered", "2026-11-27T00:00:00.000Z"));
  await h.onEvent("decision.updated", { decision_id: "K-1", change: "answered" });
  await h.sync();
  assert.ok(store.kept.has("K-1"));
  await h.keep(decision("K-old", "answered", "2026-11-10T00:00:00.000Z"));
  s.settings = 7;
  assert.deepEqual((await h.list()).map((d) => d.id), ["K-1"], "older than retention_days is dropped");
  h.setRetention(365);
  await h.keep(decision("K-old", "answered", "2026-11-10T00:00:00.000Z"));
  assert.equal((await h.list()).length, 2);
  entry = "E2";
  assert.deepEqual(await h.list(), [], "another account's history is not shown, and is dropped");
  await h.keep(decision("K-5", "cancelled"));
  await h.keep(decision("K-6", "cancelled"));
  assert.equal(await h.clear(), 2);
  await h.keep(decision("K-7", "cancelled"));
  await h.clearAll();
  assert.equal(store.kept.size, 0);
});
