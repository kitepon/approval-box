// login-billing 0.21.1 keyholes (contract 1.48 section 11), used through the public API only; the library is never edited.
// Shape: docs/architecture/local-form.md (target) and docs/architecture/login-pass.md (what runs). The server knows a device only as
// { entry, key, role }; the entry is the account (users.id). Nothing here logs an entry, a key or a body. The server never keeps K beside an
// entry (contract 11.3) and never writes the keyholes table outside the library's store calls.
import { createKeyholes, KeyholeError, type Keyhole, type KeyholeEvent, type KeyholeOps, type KeyholeRequest, type KeyholeRole, type KeyholeStore } from "@kitepon/login-billing/server";
import type { Accounts } from "./accounts.ts";
import type { Attachments } from "./attachments.ts";
import { type Db, all, get, run, tx } from "./db.ts";
import { now } from "./ids.ts";
import { userColumns } from "./rekey.ts";

export const APP_ID = "dev.kitepon.approvalbox";
/** The library's signed-request header (keyholes.js). Its presence selects the new form; the old pass stays in Authorization. */
export const SIGNED_HEADER = "login-billing-key";
/** An entry no device has used for this long is erased (local-form.md section 5, same period as unused pairings). */
export const RETENTION_DAYS = 90;

/** The library's store in SQLite. write() is one transaction (deletes first, then sets); useOnce is one statement. */
export class SqliteKeyholeStore implements KeyholeStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  keyhole(key: string): Keyhole | undefined {
    const row = get<{ entry: string; role: KeyholeRole }>(this.db, "select entry, role from keyholes where key = ?", key);
    return row && { entry: row.entry, role: row.role };
  }

  keys(entry: string) {
    return all<{ key: string; role: KeyholeRole }>(this.db, "select key, role from keyholes where entry = ? order by key", entry).map((r) => ({ key: r.key, role: r.role }));
  }

  write(ops: KeyholeOps) {
    tx(this.db, () => {
      for (const key of ops.delete) run(this.db, "delete from keyholes where key = ?", key);
      for (const [key, hole] of ops.set) {
        run(this.db, "insert into keyholes (key, entry, role) values (?, ?, ?) on conflict(key) do update set entry = excluded.entry, role = excluded.role", key, hole.entry, hole.role);
      }
    });
  }

  /** Taken when the id is new or its earlier record has expired (as MemoryKeyholeStore: kept while until >= now). */
  useOnce(id: string, untilMs: number) {
    return Number(run(this.db, "insert into keyhole_used (id, until_ms) values (?, ?) on conflict(id) do update set until_ms = excluded.until_ms where keyhole_used.until_ms < ?",
      id, untilMs, this.now()).changes) === 1;
  }

  /** Drops expired used numbers (useOnce already ignores them). */
  sweep() {
    run(this.db, "delete from keyhole_used where until_ms < ?", this.now());
  }
}

/** What the entries need from peer-channel's server part (pc.ts). */
export type PeerChannelPart = { forgetAccount(k: string): void; onPassEnded(event: { k: string; passId: string }): void; moveAccount(from: string, into: string): void };

export type EntriesInput = { db: Db; accounts: Accounts; attachments?: Attachments; peerChannel?: () => PeerChannelPart | undefined; now?: () => number };

/** The server's side of an entry: its rows (users.id = entry), retention, the K -> entry move, and the library's events. */
export function createEntries(input: EntriesInput) {
  const { db, accounts, attachments } = input;
  const clock = input.now ?? Date.now;
  // One chain for everything that reads keyholes and then writes entry rows: the library's handle (its events move and erase rows), a signed
  // request's verify + users row, and the K -> entry move. So no write lands on an entry that a join or an emptied event just took away.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  }

  /** Each accepted signed request: the users row exists and the entry was used now. */
  function signedIn(entry: string) {
    accounts.ensureUser(entry);
    seen(entry);
  }

  function seen(entry: string) {
    run(db, "insert into entries_seen (entry, last_used_at) values (?, ?) on conflict(entry) do update set last_used_at = excluded.last_used_at", entry, new Date(clock()).toISOString());
  }

  /**
   * Moves every row owned by `from` to `into` in one transaction (every column that references users.id, found from the schema).
   * A row that would collide with one `into` already has (same idempotency key, same push token) is dropped with `from`'s users row.
   * Push tokens registered without a keyhole (by the old pass) are dropped, not moved: only a keyhole's own registration reaches the entry.
   * Of the users row only created_at (the earlier), setup_verified_at and retention_days carry; never plan, plan_expires_at or store.
   * takeSettings: `from`'s retention setting wins (the K -> entry migration, whose entry is new); otherwise `into` keeps its own (entries joined).
   * Returns false when `from` has no users row (nothing to move; the K -> entry move is once-only through this).
   * The peer-channel mirror moves last in the same transaction, whether or not `from` had a users row (peer-channel 0.6.0 moveAccount: every slot
   * stays, served under `into`, so no removal is lost; `from`'s sockets close and reconnect as `into`). If it throws, the rows stay with `from` too.
   */
  function move(from: string, into: string, takeSettings = false) {
    if (from === into) return false;
    return tx(db, () => {
      const source = get<{ created_at: string; setup_verified_at: string | null; retention_days: number }>(db, "select created_at, setup_verified_at, retention_days from users where id = ?", from);
      if (source) {
        accounts.ensureUser(into);
        run(db, "update users set created_at = min(created_at, ?), setup_verified_at = coalesce(setup_verified_at, ?) where id = ?", source.created_at, source.setup_verified_at, into);
        if (takeSettings) run(db, "update users set retention_days = ? where id = ?", source.retention_days, into);
        run(db, "delete from devices where user_id = ? and keyhole is null", from);
        for (const [table, column] of userColumns(db)) run(db, `update or ignore ${table} set ${column} = ? where ${column} = ?`, into, from);
        run(db, "delete from users where id = ?", from);
      }
      const last = get<{ last_used_at: string }>(db, "select last_used_at from entries_seen where entry = ?", from)?.last_used_at;
      if (last) run(db, "insert into entries_seen (entry, last_used_at) values (?, ?) on conflict(entry) do update set last_used_at = max(last_used_at, excluded.last_used_at)", into, last);
      run(db, "delete from entries_seen where entry = ?", from);
      input.peerChannel?.()?.moveAccount(from, into);
      return !!source;
    });
  }

  /** Erases an entry's content as account deletion does (rows, files, peer-channel mirror). Keyholes are the library's: never written here. */
  function erase(entry: string) {
    const ids = attachments?.userFileIds(entry) ?? [];
    tx(db, () => {
      accounts.deleteUser(entry);
      attachments?.eraseFiles(ids);
      run(db, "delete from entries_seen where entry = ?", entry);
    });
    input.peerChannel?.()?.forgetAccount(entry);
  }

  /** Whether `key` is still a keyhole of `entry` (read only; an open stream re-checks it on each heartbeat). */
  function holds(entry: string, key: string) {
    return !!get(db, "select 1 from keyholes where key = ? and entry = ?", key, entry);
  }

  /** Erases the content of every entry unused for RETENTION_DAYS (never its keyholes). Returns how many. */
  function sweep() {
    const before = new Date(clock() - RETENTION_DAYS * 86400_000).toISOString();
    const stale = all<{ entry: string }>(db, "select entry from entries_seen where last_used_at < ?", before).map((r) => r.entry);
    for (const entry of stale) erase(entry);
    return stale.length;
  }

  /** The library's onEvent. A failure is logged as one code line and never thrown back into the library. */
  function onEvent(event: KeyholeEvent) {
    try {
      if (event.type === "added") seen(event.entry);
      else if (event.type === "removed") {
        run(db, "delete from devices where keyhole = ?", event.key);
        input.peerChannel?.()?.onPassEnded({ k: event.entry, passId: event.key }); // the device's endpoint_ref is its key (pc.ts)
      } else if (event.type === "joined") move(event.from, event.into);
      else erase(event.entry);
    } catch {
      console.error(`approval-box-server: keyhole_event_failed ${event.type}`);
    }
  }

  return { serial, signedIn, seen, move, erase, sweep, holds, onEvent };
}
export type Entries = ReturnType<typeof createEntries>;

/** The library's keyholes on our store. handle() runs on the entries' serial chain: the store has no conditional write, so two starts or accepts must not both pass their reads (docs/keyholes.md "The store"). */
export function createAppKeyholes(input: { db: Db; origin: string; entries: Entries; now?: () => number }) {
  const store = new SqliteKeyholeStore(input.db, input.now);
  const keyholes = createKeyholes({ appId: APP_ID, origin: input.origin, store, onEvent: input.entries.onEvent, ...(input.now ? { now: input.now } : {}) });
  const handle = (request: KeyholeRequest) => input.entries.serial(() => keyholes.handle(request));
  return { verify: keyholes.verify, handle, store, entries: input.entries };
}
export type AppKeyholes = Pick<ReturnType<typeof createAppKeyholes>, "verify" | "handle" | "entries">;

export { KeyholeError };
