import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type HistoryStore, type Kept } from "../src/history.ts";
import type { Decision } from "../src/types.ts";

class MemoryStore implements HistoryStore {
  readonly kept = new Map<string, Kept>();
  async all() { return [...this.kept.values()]; }
  async get(id: string) { return this.kept.get(id); }
  async put(k: Kept) { this.kept.set(k.id, structuredClone(k)); }
  async delete(ids: string[]) { for (const id of ids) this.kept.delete(id); }
}

const decision = (id: string, status: string, updated = "2026-11-28T00:00:00.000Z", extra: Partial<Decision> = {}): Decision => ({
  id, title: `title ${id}`, context: "c", options: [{ id: "a", label: "A" }], urgency: "normal",
  source: { client: "codex", session_label: "s", via: "connector" }, status, resume_phrase: "r", history: [], created_at: updated, updated_at: updated, version: 1, ...extra,
});
const tombstone = (id: string): Decision => decision(id, "answered", undefined, { title: "", context: "", options: [], history: [], content_removed: true });

/** A fake /v1: the server's decided items, its single views, and the stored acks it received. */
function server() {
  const s = { closed: [] as Decision[], views: new Map<string, Decision | 404>(), stored: [] as string[], storedFails: false, settings: 30, offline: false };
  const call = async <T,>(method: string, path: string): Promise<T> => {
    if (s.offline) throw Object.assign(new Error("network"), { status: 0 });
    if (method === "GET" && path.startsWith("/decisions?status=answered,cancelled")) return { items: s.closed } as T;
    if (method === "GET" && path === "/me/settings") return { retention_days: s.settings } as T;
    const stored = /^\/decisions\/([^/]+)\/stored$/.exec(path);
    if (method === "POST" && stored) { if (s.storedFails) throw Object.assign(new Error("x"), { status: 503 }); s.stored.push(decodeURIComponent(stored[1]!)); return { stored: true } as T; }
    const one = /^\/decisions\/([^/?]+)$/.exec(path);
    if (method === "GET" && one) {
      const v = s.views.get(decodeURIComponent(one[1]!));
      if (!v || v === 404) throw Object.assign(new Error("not found"), { status: 404 });
      return v as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { s, call };
}

test("history: decided requests are kept here and acked once with POST /decisions/{id}/stored; open ones are not kept", async () => {
  const store = new MemoryStore();
  const { s, call } = server();
  const h = createHistory({ store, call, entry: () => "E1", now: () => Date.parse("2026-11-28T12:00:00.000Z") });
  s.closed = [decision("K-1", "answered", "2026-11-28T01:00:00.000Z"), decision("K-2", "cancelled", "2026-11-28T02:00:00.000Z")];
  const listed = await h.list(); // back-fill on first load
  assert.deepEqual(listed.map((d) => d.id), ["K-2", "K-1"]);
  assert.deepEqual(s.stored.sort(), ["K-1", "K-2"]);
  await h.list();
  assert.equal(s.stored.length, 2, "an acked request is not acked again");
  await h.keep(decision("K-3", "pending"));
  assert.equal(store.kept.has("K-3"), false);
});

test("history: a failed ack is retried on the next list; content_removed on SSE drops the need to ack", async () => {
  const store = new MemoryStore();
  const { s, call } = server();
  const h = createHistory({ store, call, entry: () => "E1" });
  s.storedFails = true;
  await h.keep(decision("K-1", "answered"));
  await h.keep(decision("K-2", "answered"));
  assert.equal(store.kept.get("K-1")!.stored, false);
  await h.onEvent("decision.updated", { decision_id: "K-2", change: "content_removed" });
  assert.equal(store.kept.get("K-2")!.stored, true);
  s.storedFails = false;
  await h.list();
  assert.deepEqual(s.stored, ["K-1"]);
});

test("history: a tombstone (content_removed) or a 404 from the server shows this browser's copy; with no copy the tombstone shows", async () => {
  const store = new MemoryStore();
  const { s, call } = server();
  const h = createHistory({ store, call, entry: () => "E1" });
  const answered = decision("K-1", "answered", undefined, { answer: { option_id: "a", answered_at: "2026-11-28T00:00:00.000Z" } });
  s.views.set("K-1", answered);
  assert.equal((await h.view("K-1")).title, "title K-1"); // viewing a decided request keeps it
  assert.ok(store.kept.has("K-1"));
  s.views.set("K-1", tombstone("K-1"));
  const shown = await h.view("K-1");
  assert.equal(shown.title, "title K-1");
  assert.equal(shown.answer?.option_id, "a");
  assert.equal(shown.content_removed, undefined);
  s.views.set("K-1", 404);
  assert.equal((await h.view("K-1")).title, "title K-1");
  s.offline = true;
  assert.equal((await h.view("K-1")).title, "title K-1", "offline: the copy here");
  s.offline = false;
  s.views.set("K-9", tombstone("K-9"));
  assert.equal((await h.view("K-9")).content_removed, true);
  await assert.rejects(h.view("K-404"), (e: { status?: number }) => e.status === 404);
  // A tombstone is never kept as history.
  assert.equal(store.kept.has("K-9"), false);
});

test("history: a decided event fetches and keeps the request; retention and another account's copies are dropped; clear and clearAll", async () => {
  const store = new MemoryStore();
  const { s, call } = server();
  let entry = "E1";
  const h = createHistory({ store, call, entry: () => entry, now: () => Date.parse("2026-11-28T00:00:00.000Z") });
  s.views.set("K-1", decision("K-1", "answered", "2026-11-27T00:00:00.000Z"));
  await h.onEvent("decision.updated", { decision_id: "K-1", change: "answered" });
  assert.ok(store.kept.has("K-1"));
  await h.keep(decision("K-old", "answered", "2026-11-10T00:00:00.000Z"));
  s.settings = 7;
  assert.deepEqual((await h.list()).map((d) => d.id), ["K-1"], "older than retention_days is dropped");
  assert.equal(store.kept.has("K-old"), false);
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
