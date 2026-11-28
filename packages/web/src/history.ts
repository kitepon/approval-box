import type { Attachment, Decision } from "./types";

// This browser's history of decided requests (docs/api.md v0.51-0.52, e02), as the phone apps keep theirs: the server deletes a decided request's
// content and files once every device has said it stored it (POST /decisions/{id}/stored), so the copy here, with its files, is what 履歴 shows.
// Every call this module makes on its own (back-fill, files, stored) is paced under the server's signed-request limit (240 a minute per source).

/** `stored`: nothing more to send for this request (acked, or the server already removed its content). */
export type Kept = { id: string; entry: string; decision: Decision; files: Record<string, Blob>; stored: boolean };
export interface HistoryStore {
  all(): Promise<Kept[]>;
  get(id: string): Promise<Kept | undefined>;
  put(kept: Kept): Promise<void>;
  delete(ids: string[]): Promise<void>;
}

type Call = <T>(method: string, path: string) => Promise<T>;
const DECIDED = ["answered", "cancelled"];
const status = (error: unknown) => (error as { status?: number }).status;
const attachmentsOf = (d: Decision): Attachment[] => [...(d.request_attachments ?? []), ...(d.answer?.attachments ?? [])];
const newest = (a: { updated_at: string }, b: { updated_at: string }) => (a.updated_at < b.updated_at ? 1 : -1);
/** A 429 stopped this pass: the next load resumes after Retry-After. */
class Paused extends Error {}

export function createHistory(deps: {
  store: HistoryStore; call: Call; fetchFile: (decisionId: string, attachmentId: string) => Promise<Blob>; entry: () => string | undefined;
  /** Called when a copy was added or changed, so 履歴 reloads. */
  onChange?: () => void;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** At least this long between two calls of this module: 500 ms is 2 a second, far under the 240 a minute of the server. */
  gapMs?: number;
}) {
  const { store, call } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = deps.gapMs ?? 500;
  let retention: number | undefined;
  let next = 0, pausedUntil = 0;
  let running: Promise<void> | undefined;

  /** One call in the pace. A 429 pauses every call of this module until Retry-After (60 s when absent) and ends the pass; nothing retries in a loop. */
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const t = now();
    if (t < pausedUntil) throw new Paused();
    const at = Math.max(t, next);
    next = at + gap;
    if (at > t) await sleep(at - t);
    try { return await fn(); } catch (error) {
      if (status(error) === 429) { pausedUntil = now() + ((error as { retryAfterMs?: number }).retryAfterMs ?? 60_000); throw new Paused(); }
      throw error;
    }
  }

  const mine = async (id: string) => { const kept = await store.get(id); return kept && kept.entry === deps.entry() ? kept : undefined; };

  /** True when the server no longer has the request's content (tombstone or gone): nothing can be fetched or acked any more. */
  async function removed(id: string) {
    try { return !!(await paced(() => call<Decision>("GET", `/decisions/${encodeURIComponent(id)}`))).content_removed; }
    catch (error) { if (error instanceof Paused) throw error; return status(error) === 404; }
  }

  /** Saves the files the copy lacks, then acks. A file that failed is tried again on the next load, and the request is not acked until it is here. */
  async function complete(kept: Kept) {
    const files = { ...kept.files };
    let failed = false, notFound = false;
    for (const a of attachmentsOf(kept.decision)) {
      if (files[a.id]) continue;
      try { files[a.id] = await paced(() => deps.fetchFile(kept.id, a.id)); }
      catch (error) { if (error instanceof Paused) throw error; failed = true; notFound ||= status(error) === 404; }
    }
    let stored = false;
    if (!failed) {
      try { await paced(() => call("POST", `/decisions/${encodeURIComponent(kept.id)}/stored`)); stored = true; }
      catch (error) { if (error instanceof Paused) { await store.put({ ...kept, files }); throw error; } }
    } else if (notFound) stored = await removed(kept.id); // purged meanwhile: the files are gone for good
    await store.put({ ...kept, files, stored });
  }

  /** Keeps a decided request that still has its content (an update replaces the copy, its files stay), then completes it. */
  async function keepOne(d: Decision) {
    const entry = deps.entry();
    if (!entry || !DECIDED.includes(d.status) || d.content_removed) return;
    const had = await mine(d.id);
    const kept: Kept = { id: d.id, entry, decision: d, files: had?.files ?? {}, stored: had?.stored ?? false };
    await store.put(kept);
    if (had?.decision.version !== d.version) deps.onChange?.();
    if (!kept.stored) await complete(kept);
  }
  const quiet = (p: Promise<unknown>) => p.then(() => undefined, (error) => { if (!(error instanceof Paused)) throw error; });

  /**
   * One back-fill pass, at most one at a time: the server's decided requests newest first (a request already stored here with the same version is
   * skipped, so a pass cut short resumes where it stopped), then the copies here still missing a file or the ack. Ends at a 429 or offline.
   */
  async function pass() {
    const tried = new Set<string>();
    try {
      for (let cursor = "";;) {
        const page = await paced(() => call<{ items: Decision[]; next_cursor?: string }>("GET", `/decisions?status=answered,cancelled&limit=200${cursor ? `&cursor=${cursor}` : ""}`));
        for (const d of [...page.items].sort(newest)) {
          const had = await mine(d.id);
          if (had?.stored && had.decision.version === d.version) continue;
          tried.add(d.id);
          await keepOne(d);
        }
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      const entry = deps.entry();
      const left = (await store.all()).filter((k) => k.entry === entry && !k.stored && !tried.has(k.id)).sort((a, b) => newest(a.decision, b.decision));
      for (const k of left) await complete(k);
    } catch { /* 429 (paused) or offline: the next load resumes */ }
  }
  const sync = () => (running ??= pass().finally(() => { running = undefined; }));

  /** 履歴: the copies here at once (the back-fill runs behind and calls onChange), without what is past the account's retention or of another account. */
  async function list(): Promise<Decision[]> {
    void sync();
    if (retention === undefined) retention = await call<{ retention_days: number }>("GET", "/me/settings").then((r) => r.retention_days, () => undefined);
    const cutoff = retention === undefined ? -Infinity : now() - retention * 86400_000;
    const entry = deps.entry();
    const all = await store.all();
    const gone = all.filter((k) => k.entry !== entry || Date.parse(k.decision.updated_at) < cutoff);
    if (gone.length) await store.delete(gone.map((k) => k.id));
    return all.filter((k) => !gone.includes(k)).map((k) => k.decision).sort(newest);
  }

  /** The copy here with the tombstone's metadata (delivery, status, version: no content). */
  async function merge(kept: Kept, tomb: Pick<Decision, "status" | "delivery" | "updated_at" | "version">) {
    const decision = { ...kept.decision, status: tomb.status, ...(tomb.delivery ? { delivery: tomb.delivery } : {}), updated_at: tomb.updated_at, version: tomb.version };
    await store.put({ ...kept, decision, stored: true });
    return decision;
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
    if (d.content_removed) { const kept = await mine(id); return kept ? merge(kept, d) : d; }
    void quiet(keepOne(d)).catch(() => {});
    return d;
  }

  /** SSE: content_removed carries the delivery state (v0.52) and ends what there is to send; a request decided or delivered elsewhere is fetched again. */
  async function onEvent(type: string, data: Record<string, unknown>) {
    const id = typeof data.decision_id === "string" ? data.decision_id : undefined;
    if (type !== "decision.updated" || !id) return;
    if (data.change === "content_removed") {
      const kept = await mine(id);
      if (kept) await store.put({ ...kept, stored: true, decision: { ...kept.decision, ...(typeof data.delivery === "string" ? { delivery: data.delivery } : {}) } });
    } else if (data.change === "answered" || data.change === "cancelled" || data.change === "delivery") {
      await view(id).catch(() => {});
    }
  }

  /** A file of a request: this browser's copy when it has one. */
  async function file(decisionId: string, attachmentId: string) { return (await mine(decisionId))?.files?.[attachmentId]; }

  /** Deletes this account's history here (設定 → 履歴を削除); answers how many. */
  async function clear() {
    const entry = deps.entry();
    const ids = (await store.all()).filter((k) => k.entry === entry).map((k) => k.id);
    await store.delete(ids);
    return ids.length;
  }

  /** Sign-out: nothing of any account stays in this browser. */
  async function clearAll() { await store.delete((await store.all()).map((k) => k.id)); }

  return { keep: (d: Decision) => quiet(keepOne(d)), sync, list, view, onEvent, file, clear, clearAll, setRetention: (days: number) => { retention = days; } };
}
export type History = ReturnType<typeof createHistory>;

/** The origin's IndexedDB, database "approval-box-history", one record per request id (its files as Blobs); never synced. */
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
