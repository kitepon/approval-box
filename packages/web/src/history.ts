import type { Decision } from "./types";

// This browser's history of decided requests (docs/api.md v0.51, e02), as the phone apps keep theirs: the server deletes a decided request's
// content once every device of the account has said it stored it (POST /decisions/{id}/stored), so the copy here is what 履歴 shows.

export type Kept = { id: string; entry: string; decision: Decision; stored: boolean };
export interface HistoryStore {
  all(): Promise<Kept[]>;
  get(id: string): Promise<Kept | undefined>;
  put(kept: Kept): Promise<void>;
  delete(ids: string[]): Promise<void>;
}

type Call = <T>(method: string, path: string) => Promise<T>;
const DECIDED = ["answered", "cancelled"];
const status = (error: unknown) => (error as { status?: number }).status;

export function createHistory(deps: { store: HistoryStore; call: Call; entry: () => string | undefined; now?: () => number }) {
  const { store, call } = deps;
  const now = deps.now ?? Date.now;
  let retention: number | undefined;

  const mine = async (id: string) => { const kept = await store.get(id); return kept && kept.entry === deps.entry() ? kept : undefined; };

  /** Tells the server this browser holds the request. A failure is retried on the next list(). */
  async function ack(kept: Kept) {
    try { await call("POST", `/decisions/${encodeURIComponent(kept.id)}/stored`); } catch { return; }
    await store.put({ ...kept, stored: true });
  }

  /** Keeps a decided request that still has its content, then acks it once. Open requests and tombstones are not kept. */
  async function keep(d: Decision) {
    const entry = deps.entry();
    if (!entry || !DECIDED.includes(d.status) || d.content_removed) return;
    const had = await store.get(d.id);
    const kept = { id: d.id, entry, decision: d, stored: had?.entry === entry && had.stored };
    await store.put(kept);
    if (!kept.stored) await ack(kept);
  }

  /** 履歴: back-fills what the server still holds, drops what is past the account's retention (as the server did before e02) or of another account, newest first. */
  async function list(): Promise<Decision[]> {
    try {
      for (let cursor = "";;) {
        const page = await call<{ items: Decision[]; next_cursor?: string }>("GET", `/decisions?status=answered,cancelled&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
        for (const d of page.items) await keep(d);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
    } catch { /* offline or refused: the history here still shows */ }
    if (retention === undefined) retention = await call<{ retention_days: number }>("GET", "/me/settings").then((r) => r.retention_days, () => undefined);
    const cutoff = retention === undefined ? -Infinity : now() - retention * 86400_000;
    const entry = deps.entry();
    const all = await store.all();
    const gone = all.filter((k) => k.entry !== entry || Date.parse(k.decision.updated_at) < cutoff);
    if (gone.length) await store.delete(gone.map((k) => k.id));
    const kept = all.filter((k) => !gone.includes(k));
    for (const k of kept) if (!k.stored) await ack(k);
    return kept.map((k) => k.decision).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  /** One request: the server's copy, or this browser's copy when the server answers a tombstone (content_removed), 404 or nothing (offline). */
  async function view(id: string): Promise<Decision> {
    let d: Decision;
    try {
      d = await call<Decision>("GET", `/decisions/${encodeURIComponent(id)}`);
    } catch (error) {
      const kept = status(error) === 404 || status(error) === 0 ? await mine(id) : undefined;
      if (kept) return kept.decision;
      throw error;
    }
    if (d.content_removed) return (await mine(id))?.decision ?? d;
    await keep(d);
    return d;
  }

  /** SSE: content_removed drops the server copy (nothing to ack any more); a request decided elsewhere is kept. */
  async function onEvent(type: string, data: Record<string, unknown>) {
    const id = typeof data.decision_id === "string" ? data.decision_id : undefined;
    if (type !== "decision.updated" || !id) return;
    if (data.change === "content_removed") {
      const kept = await mine(id);
      if (kept && !kept.stored) await store.put({ ...kept, stored: true });
    } else if (data.change === "answered" || data.change === "cancelled") {
      await view(id).catch(() => {});
    }
  }

  /** Deletes this account's history here (設定 → 履歴を削除); answers how many. */
  async function clear() {
    const entry = deps.entry();
    const ids = (await store.all()).filter((k) => k.entry === entry).map((k) => k.id);
    await store.delete(ids);
    return ids.length;
  }

  /** Sign-out: nothing of any account stays in this browser. */
  async function clearAll() { await store.delete((await store.all()).map((k) => k.id)); }

  return { keep, list, view, onEvent, clear, clearAll, setRetention: (days: number) => { retention = days; } };
}
export type History = ReturnType<typeof createHistory>;

/** The origin's IndexedDB, database "approval-box-history", one record per request id; never synced. */
export class IndexedDbHistoryStore implements HistoryStore {
  private run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("approval-box-history", 1);
      open.onupgradeneeded = () => { open.result.createObjectStore("decisions", { keyPath: "id" }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("decisions", mode);
        const request = f(tx.objectStore("decisions"));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  all() { return this.run<Kept[]>("readonly", (s) => s.getAll()); }
  get(id: string) { return this.run<Kept | undefined>("readonly", (s) => s.get(id)); }
  async put(kept: Kept) { await this.run("readwrite", (s) => s.put(kept)); }
  async delete(ids: string[]) { if (ids.length) await this.run("readwrite", (s) => { for (const id of ids) s.delete(id); return s.count(); }); }
}
