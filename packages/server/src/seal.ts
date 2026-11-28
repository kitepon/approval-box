// Sealed content at rest (docs/architecture/storage-lifecycle.md "Sealed content", e02): every request's content is stored as lbd1 records
// (AES-256-GCM) under a per-account data key, through login-billing 0.28.0 data sets (contract 1.64 section 12.10). The data key is kept only
// wrapped by the master-key window: the auth module (AUTH_MODULE_SOCKET, grant approvalbox-data) or, for self-hosters and tests, ABX_DATA_KEY.
// Without a window nothing new is stored: the server answers 503 store_unavailable. Nothing here logs a set, a context or content.
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDataSets, keyWindow, TeamError, type DataSets, type DataSetStore, type KeyWindow } from "login-billing-028/server";
import { brokerWindow } from "login-billing-028/window-broker";
import { APP_ID } from "./keyholes.ts";
import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";

/** The auth module's grant for this server's data keys. */
export const DATA_KEY_NAME = "approvalbox-data";
const LOCAL_KEY_NAME = "local";
/** Unwrapped data keys stay in memory this long between calls (design: at most 600 s). */
const KEY_CACHE_SECONDS = 60;
const PREFIX = "dset:";
/** Decided content goes once the AI has it and every device stored it, or after this at most (storage-lifecycle.md "Sealed content"). */
export const PURGE_CAP_MS = 7 * 86400_000;
const BATCH = 50;
const UNAVAILABLE = "申請の中身を暗号にする鍵が使えないため、今は受け付けられません。時間を置いて試してください。";

/** Every table whose rows carry sealed values, with its sealed columns. history.note follows its decision's set. */
export const SEALED_COLUMNS: Record<string, string[]> = {
  decisions: ["title", "context", "options", "recommendation", "answer", "delivery_text", "cancel_reason", "distinct_reason"],
  attachments: ["name"],
  request_uploads: ["name"],
  idempotency: ["body"],
};

/** The library's DataSetStore on SQLite: one row per key (JSON), and write() in one transaction. */
export class SqliteDataSetStore implements DataSetStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }
  record(key: string) {
    const value = get<{ value: string }>(this.db, "select value from data_sets where key = ?", key)?.value;
    return value === undefined ? undefined : JSON.parse(value) as unknown;
  }
  records(prefix: string) {
    return all<{ key: string; value: string }>(this.db, "select key, value from data_sets where substr(key, 1, ?) = ? order by key", prefix.length, prefix)
      .map((r) => [r.key, JSON.parse(r.value)] as [string, unknown]);
  }
  write(ops: { set: unknown[]; delete: string[]; put?: [string, unknown][]; remove?: string[] }) {
    // Data sets never write keyholes (datasets.js passes them empty).
    if (ops.set.length) throw new Error("data_sets: keyhole ops are not stored here");
    tx(this.db, () => {
      for (const key of [...ops.delete, ...(ops.remove ?? [])]) run(this.db, "delete from data_sets where key = ?", key);
      for (const [key, value] of ops.put ?? []) run(this.db, "insert into data_sets (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, JSON.stringify(value));
    });
  }
}

type SetRecord = { set: string; dk: { current: number; items: { n: number }[] } };

const isSealed = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
const MAGIC = [0x6c, 0x62, 0x64, 0x31]; // "lbd1"
export const looksSealed = (bytes: Uint8Array) => bytes.length >= 36 && MAGIC.every((b, i) => bytes[i] === b);

/** The window failed (module down, key missing): 503. Anything else from the library is a broken record: logged as its code only, 500. */
function mapped(error: unknown): never {
  if (error instanceof TeamError) {
    if (error.code === "window_unavailable" || error.code === "window_denied" || error.code === "token_unavailable") throw new ApiError("store_unavailable", UNAVAILABLE);
    console.error(`approval-box-server: sealed_content_failed ${error.code}`);
    throw new ApiError("internal", "サーバーで問題が起きました。時間を置いて試してください。");
  }
  throw error;
}

export class Vault {
  private readonly db: Db;
  private readonly sets: DataSets | undefined;
  /** Why there is no window (setting names only), or undefined when ready. */
  readonly problem: string | undefined;

  constructor(db: Db, window?: KeyWindow, problem?: string) {
    this.db = db;
    this.sets = window ? createDataSets({ appId: APP_ID, store: new SqliteDataSetStore(db), window, rotateDays: 30, keyCacheSeconds: KEY_CACHE_SECONDS }) : undefined;
    this.problem = window ? undefined : problem ?? "no window";
  }

  get ready() { return !!this.sets; }

  /** Refuses (503) when nothing can be sealed. */
  assertReady(): DataSets {
    if (!this.sets) throw new ApiError("store_unavailable", UNAVAILABLE);
    return this.sets;
  }

  async sealBytes(set: string, context: string, plain: Uint8Array): Promise<Uint8Array> {
    const sets = this.assertReady();
    return sets.seal(set, context, plain).catch(mapped);
  }

  async seal(set: string, context: string, text: string): Promise<Uint8Array>;
  async seal(set: string, context: string, text: string | null): Promise<Uint8Array | null>;
  async seal(set: string, context: string, text: string | null) {
    return text === null ? null : this.sealBytes(set, context, new TextEncoder().encode(text));
  }

  async openBytes(set: string, context: string, record: Uint8Array): Promise<Uint8Array> {
    const sets = this.assertReady();
    return sets.open(set, context, record).catch(mapped);
  }

  /** A sealed value is opened; text is a row from before the migration (or a server without a window) and is returned as it is. */
  async open(set: string, context: string, value: unknown): Promise<string | null> {
    if (value === null || value === undefined) return null;
    if (!isSealed(value)) return String(value);
    return new TextDecoder().decode(await this.openBytes(set, context, value));
  }

  /** Deletes the data keys of sets that no row references and that are no account (account deletion; rows moved between entries keep theirs). */
  async forget(candidates: Iterable<string>) {
    if (!this.sets) return 0;
    let forgotten = 0;
    for (const set of new Set(candidates)) {
      if (!get(this.db, "select 1 from data_sets where key = ?", PREFIX + set) || referenced(this.db, set)) continue;
      await this.sets.deleteSet(set).catch(mapped);
      forgotten++;
    }
    return forgotten;
  }

  /**
   * Hourly: rotates data keys past 30 days, retires an old key once no record is sealed under it, and forgets sets of deleted accounts.
   * Records are resealed lazily: every write reseals the whole row under the current key, and no content outlives 14 days (open requests
   * expire, decided ones go within 7), so an old key empties by itself.
   */
  async sweep(attachmentsDir?: string) {
    if (!this.sets) return { rotated: 0, retired: 0, forgotten: 0 };
    const { rotated } = await this.sets.sweep().catch(mapped);
    let retired = 0;
    const records = new SqliteDataSetStore(this.db).records(PREFIX) as [string, SetRecord][];
    for (const [, record] of records) {
      for (const item of record.dk.items) {
        if (item.n === record.dk.current || usesKey(this.db, record.set, item.n, attachmentsDir)) continue;
        await this.sets.retire(record.set, item.n).catch(mapped);
        retired++;
      }
    }
    const forgotten = await this.forget(records.map(([, r]) => r.set));
    return { rotated, retired, forgotten };
  }
}

/** Whether any row is sealed under the set, or the set is an account (users.id). */
function referenced(db: Db, set: string) {
  if (get(db, "select 1 from users where id = ?", set)) return true;
  return Object.keys(SEALED_COLUMNS).some((table) => !!get(db, `select 1 from ${table} where sealed_set = ? limit 1`, set));
}

/** Whether a record of the set is still sealed under data key n (the lbd1 header carries n, big-endian, after the magic). */
function usesKey(db: Db, set: string, n: number, attachmentsDir?: string) {
  const header = n.toString(16).toUpperCase().padStart(8, "0");
  for (const [table, columns] of Object.entries(SEALED_COLUMNS)) {
    const where = columns.map((c) => `(typeof(${c}) = 'blob' and hex(substr(${c}, 5, 4)) = ?)`).join(" or ");
    if (get(db, `select 1 from ${table} where sealed_set = ? and (${where}) limit 1`, set, ...columns.map(() => header))) return true;
  }
  if (get(db, "select 1 from history h join decisions d on d.id = h.decision_id where d.sealed_set = ? and typeof(h.note) = 'blob' and hex(substr(h.note, 5, 4)) = ? limit 1", set, header)) return true;
  if (!attachmentsDir) return false;
  for (const { id } of all<{ id: string }>(db, "select id from attachments where sealed_set = ? union select id from request_uploads where sealed_set = ?", set, set)) {
    const head = readHead(join(attachmentsDir, id));
    if (head && looksSealed(head) && Buffer.from(head.subarray(4, 8)).toString("hex").toUpperCase() === header) return true;
  }
  return false;
}

function readHead(file: string): Uint8Array | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(36);
    const n = readSync(fd, head, 0, 36, 0);
    return head.subarray(0, n);
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Seals every row still in plaintext, in place (at start, before serving). One transaction per batch, and a row is replaced only while it is
 * still the row that was read, so each row is either plain or sealed, never neither. Resumable: the next start continues with what is left;
 * an attachment file already sealed (a stop between its rename and its row) is recognized by opening it. Already-decided requests are not
 * purged at once: their 7-day cap counts from now, so the updated apps can store them first. Returns how many rows were sealed per table.
 */
export async function sealExisting(db: Db, attachmentsDir: string | undefined, at = Date.now()) {
  const vault = vaultOf(db);
  vault.assertReady();
  const counts = { decisions: 0, attachments: 0, request_uploads: 0, idempotency: 0 };
  const stamp = new Date(at).toISOString();
  const cap = new Date(at + PURGE_CAP_MS).toISOString();
  const columns = SEALED_COLUMNS.decisions!;
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  for (;;) {
    const rows = all<Record<string, unknown> & { id: string; user_id: string; version: number }>(db, "select * from decisions where content_state = 'plain' order by id limit ?", BATCH);
    if (!rows.length) break;
    const prepared = await Promise.all(rows.map(async (row) => ({
      row,
      sealed: await Promise.all(columns.map((c) => vault.seal(row.user_id, `${row.id}|${c}`, text(row[c])))),
      notes: await Promise.all(all<{ id: number; note: string }>(db, "select id, note from history where decision_id = ? and typeof(note) = 'text'", row.id)
        .map(async (h) => ({ ...h, sealed: await vault.seal(row.user_id, `${row.id}|note`, h.note) }))),
    })));
    const done = tx(db, () => {
      let n = 0;
      for (const { row, sealed, notes } of prepared) {
        const changed = run(db, `update decisions set ${columns.map((c) => `${c} = ?`).join(", ")}, norm_title = '', content_state = 'sealed', sealed_set = user_id,
            decided_at = case when status in ('answered','cancelled') then coalesce(decided_at,
              (select max(at) from history where decision_id = decisions.id and kind in ('answered','cancelled')), updated_at) else decided_at end,
            purge_by = case when status in ('answered','cancelled') then ? else purge_by end,
            ai_seen_at = case when status = 'cancelled' or delivery in ('delivered','fetched') then coalesce(ai_seen_at, ?) else ai_seen_at end
            where id = ? and content_state = 'plain' and version = ?`, ...sealed, cap, stamp, row.id, row.version).changes;
        if (!changed) continue;
        for (const h of notes) run(db, "update history set note = ? where id = ? and note = ?", h.sealed, h.id, h.note);
        n++;
      }
      return n;
    });
    if (!done) throw new Error("sealExisting: no progress on decisions");
    counts.decisions += done;
  }
  for (const table of ["attachments", "request_uploads"] as const) {
    for (;;) {
      const rows = all<{ id: string; user_id: string; name: string }>(db, `select id, user_id, name from ${table} where sealed_set is null order by id limit ?`, BATCH);
      if (!rows.length) break;
      const prepared: { id: string; user_id: string; name: string; sealedName: Uint8Array }[] = [];
      for (const row of rows) {
        // The file first (a sealed file under a plain row is recognized next time), then the row.
        const file = attachmentsDir ? join(attachmentsDir, row.id) : undefined;
        if (file && existsSync(file)) {
          const bytes = readFileSync(file);
          const sealedAlready = looksSealed(bytes) && await vault.openBytes(row.user_id, `${row.id}|file`, bytes).then(() => true, () => false);
          if (!sealedAlready) {
            writeFileSync(`${file}.part`, await vault.sealBytes(row.user_id, `${row.id}|file`, bytes), { mode: 0o600 });
            renameSync(`${file}.part`, file);
          }
        }
        prepared.push({ ...row, sealedName: await vault.seal(row.user_id, `${row.id}|name`, String(row.name)) });
      }
      const done = tx(db, () => prepared.reduce((n, r) => n + Number(run(db, `update ${table} set name = ?, sealed_set = user_id where id = ? and sealed_set is null`, r.sealedName, r.id).changes), 0));
      if (!done) throw new Error(`sealExisting: no progress on ${table}`);
      counts[table] += done;
    }
  }
  for (;;) {
    const rows = all<{ user_id: string; key: string; body: string }>(db, "select user_id, key, body from idempotency where sealed_set is null limit ?", BATCH);
    if (!rows.length) break;
    const prepared = await Promise.all(rows.map(async (r) => ({ ...r, sealed: await vault.seal(r.user_id, `idempotency|${r.key}`, String(r.body)) })));
    const done = tx(db, () => prepared.reduce((n, r) => n + Number(run(db, "update idempotency set body = ?, sealed_set = user_id where user_id = ? and key = ? and sealed_set is null", r.sealed, r.user_id, r.key).changes), 0));
    if (!done) throw new Error("sealExisting: no progress on idempotency");
    counts.idempotency += done;
  }
  // The plaintext must not stay in free pages or the WAL (secure_delete zeroes freed cells; vacuum and the checkpoint rewrite the rest).
  if (Object.values(counts).some(Boolean)) {
    db.exec("vacuum");
    db.exec("pragma wal_checkpoint(truncate)");
  }
  return counts;
}

/** The window from the environment: the auth module when AUTH_MODULE_SOCKET is set, else ABX_DATA_KEY(_FILE) (base64, 32 bytes). */
export function vaultFromEnv(db: Db, env: Record<string, string | undefined>): Vault {
  const socket = env.AUTH_MODULE_SOCKET?.trim();
  if (socket) return new Vault(db, brokerWindow({ socket, name: DATA_KEY_NAME }));
  const file = env.ABX_DATA_KEY_FILE?.trim();
  let raw = env.ABX_DATA_KEY?.trim() ?? "";
  if (file) {
    try { raw = readFileSync(file, "utf8").trim(); } catch { return new Vault(db, undefined, "ABX_DATA_KEY_FILE is not readable"); }
  }
  if (!raw) return new Vault(db, undefined, "neither AUTH_MODULE_SOCKET nor ABX_DATA_KEY is set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) return new Vault(db, undefined, "ABX_DATA_KEY is not 32 bytes of base64");
  return new Vault(db, keyWindow({ keys: { [LOCAL_KEY_NAME]: new Uint8Array(key) }, current: LOCAL_KEY_NAME }));
}

const vaults = new WeakMap<Db, Vault>();
/** The vault of this database: the one attached, or the one the environment configures (made once). */
export function vaultOf(db: Db): Vault {
  let vault = vaults.get(db);
  if (!vault) { vault = vaultFromEnv(db, process.env); vaults.set(db, vault); }
  return vault;
}
export function attachVault(db: Db, vault: Vault) { vaults.set(db, vault); }
