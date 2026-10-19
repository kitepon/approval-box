import { hash } from "./ids.ts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const schema = `
create table if not exists diagnostics (
 id integer primary key autoincrement,
 user_id text not null references users(id) on delete cascade,
 event_id text not null, received_at text not null, payload text not null,
 payload_hash text not null, fingerprint text not null, severity text not null,
 resolved_at text, unique(user_id,event_id)
);
create index if not exists diagnostics_received on diagnostics(received_at);
create index if not exists diagnostics_fingerprint on diagnostics(fingerprint);
create table if not exists diagnostic_groups (
 fingerprint text primary key, severity text not null, message_template text not null,
 occurrence_count integer not null, first_seen text not null, last_seen text not null,
 status text not null, payload text not null, resolved_at text, resolution_note text
);
create table if not exists diagnostic_receipts (
 user_id text not null references users(id) on delete cascade, event_id text not null,
 payload_hash text not null, created_at text not null, primary key(user_id,event_id)
);
create index if not exists diagnostic_receipts_event on diagnostic_receipts(event_id,payload_hash);
create table if not exists diagnostic_rate (
 bucket text not null, scope text not null, count integer not null, primary key(bucket,scope)
);
create table if not exists diagnostic_group_sources (
 fingerprint text not null references diagnostic_groups(fingerprint) on delete cascade,
 user_id text not null references users(id) on delete cascade,
 occurrence_count integer not null, first_seen text not null, last_seen text not null,
 payload text not null, primary key(fingerprint,user_id)
);
create index if not exists diagnostic_group_sources_user on diagnostic_group_sources(user_id,fingerprint);

create table if not exists users (
  id text primary key,
  created_at text not null,
  setup_verified_at text,
  retention_days integer not null default 30,
  plan text not null default 'trial',
  plan_expires_at text,
  store text
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  label text,
  created_at text not null,
  expires_at text not null
);
create table if not exists identities (
  provider text not null,
  subject text not null,
  user_id text not null references users(id) on delete cascade,
  email text,
  created_at text not null,
  primary key (provider, subject)
);
create table if not exists auth_flows (
  state text primary key,
  provider text not null,
  nonce text not null,
  link_user_id text references users(id) on delete cascade,
  code_challenge text not null,
  created_at text not null,
  expires_at text not null,
  used_at text
);
create table if not exists login_links (
  code_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  label text,
  created_at text not null,
  expires_at text not null,
  used_at text
);
create table if not exists connections (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  label text not null,
  os text,
  clients text not null default '[]',
  token_hash text unique,
  created_at text not null,
  last_seen_at text,
  revoked_at text
);
create table if not exists pairings (
  id text primary key,
  code text not null unique,
  poll_secret_hash text not null,
  device_name text not null,
  os text,
  clients text not null default '[]',
  status text not null,
  user_id text references users(id) on delete cascade,
  connection_id text references connections(id) on delete cascade,
  token text,
  created_at text not null,
  expires_at text not null
);
create table if not exists decisions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  connection_id text,
  route text,
  title text not null,
  norm_title text not null,
  context text not null,
  options text not null,
  recommendation text,
  urgency text not null,
  deadline text,
  client text not null,
  session_label text not null,
  requester text,
  via text not null,
  test integer not null default 0,
  status text not null,
  answer text,
  delivery text,
  delivery_id text,
  delivery_detail text,
  delivery_text text,
  resume_phrase text not null,
  cancel_reason text,
  distinct_reason text,
  amend_count integer not null default 0,
  created_at text not null,
  updated_at text not null,
  version integer not null
);
create index if not exists decisions_user_status on decisions(user_id, status);
create index if not exists decisions_connection on decisions(connection_id, status);
create table if not exists history (
  id integer primary key autoincrement,
  decision_id text not null references decisions(id) on delete cascade,
  at text not null,
  kind text not null,
  by text not null,
  note text,
  fields text
);
create index if not exists history_decision on history(decision_id);
create table if not exists events (
  id integer primary key autoincrement,
  user_id text not null references users(id) on delete cascade,
  type text not null,
  data text not null,
  at text not null
);
create index if not exists events_user on events(user_id, id);
create table if not exists idempotency (
  user_id text not null references users(id) on delete cascade,
  key text not null,
  route text not null,
  status integer not null,
  body text not null,
  created_at text not null,
  primary key (user_id, key)
);
create table if not exists appstore_subscriptions (
  original_transaction_id text primary key,
  user_id text not null references users(id) on delete cascade,
  environment text not null,
  product_id text not null,
  expires_at text,
  revoked integer not null default 0,
  updated_at text not null
);
create table if not exists attachments (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  decision_id text not null references decisions(id) on delete cascade,
  name text not null,
  content_type text not null,
  kind text not null,
  size integer not null,
  sha256 text not null,
  idem_key text,
  position integer,
  created_at text not null,
  unique (user_id, idem_key)
);
create index if not exists attachments_decision on attachments(decision_id, position);
create table if not exists request_uploads (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  connection_id text not null references connections(id) on delete cascade,
  name text not null, content_type text not null, kind text not null,
  size integer not null, sha256 text not null, created_at text not null,
  unique(connection_id, sha256, name)
);
create table if not exists request_checks (
  token_hash text primary key,
  connection_id text not null references connections(id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  used_at text
);
create table if not exists setup_checks (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  connection_id text not null,
  client text not null,
  os text,
  status text not null,
  decision_id text,
  code text,
  passed_at text,
  tested_at text,
  failed_step text,
  detail text,
  unique (connection_id, client)
);
`;

const DEVICES = `
create table if not exists devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  platform text not null,
  push_key text not null,
  apns_token text,
  apns_env text,
  fcm_token text,
  web_push_subscription text,
  created_at text not null,
  updated_at text not null,
  unique (user_id, push_key)
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * 既にあるDBの形を新しい形へ移す。user_version が版。「無ければ作る」だけでは列の違う古い表が残るため、移す手順はここに足していく。
 * 各手順は、新しいDBにも古いDBにも同じ結果になるように書く。
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // 1: devices。最初の形（push_key・updated_at が無い）から作り直す。行は宛先ごとの鍵を付けて移す。
  (db) => {
    const columns = all<{ name: string }>(db, "select name from pragma_table_info('devices')").map((c) => c.name);
    if (columns.includes("push_key")) return;
    const rows = columns.length ? all<Record<string, string | null>>(db, "select * from devices") : [];
    db.exec("drop table if exists devices");
    db.exec(DEVICES);
    for (const r of rows) {
      const key = r.platform === "ios" ? r.apns_token : r.platform === "android" ? r.fcm_token : r.web_push_subscription;
      if (!key) continue;
      run(db, "insert or ignore into devices (id, user_id, platform, push_key, apns_token, apns_env, fcm_token, web_push_subscription, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.id!, r.user_id!, r.platform!, `${r.platform}:${hash(key)}`, r.apns_token ?? null, r.apns_env ?? null, r.fcm_token ?? null, r.web_push_subscription ?? null, r.created_at!, r.created_at!);
    }
  },
  // 2: login_links に code_challenge（アプリへ返す一度きりのコードを、始めたアプリだけが使えるようにする）。
  (db) => {
    const columns = all<{ name: string }>(db, "select name from pragma_table_info('login_links')").map((c) => c.name);
    if (!columns.includes("code_challenge")) db.exec("alter table login_links add column code_challenge text");
  },
  // 3: ログイン用のURL・コードの廃止（クオの裁定）。固定のログインURLの表を消し、アプリに結ばれていないコードを捨てる。
  (db) => {
    db.exec("drop table if exists personal_links");
    db.exec("delete from login_links where code_challenge is null");
  },
  // 4: 管理者の調査注記。診断原本・集計・解決状態から独立して保存する。
  (db) => {
    db.exec(`create table if not exists diagnostic_investigations (
      fingerprint text primary key references diagnostic_groups(fingerprint) on delete cascade,
      summary text not null, evidence text not null, updated_at text not null
    )`);
  },
  // 5: 申請画像と回答添付を分離。既存行はすべて回答添付。
  (db) => {
    const columns = all<{ name: string }>(db, "select name from pragma_table_info('attachments')").map(c => c.name);
    if (!columns.includes("purpose")) db.exec("alter table attachments add column purpose text not null default 'answer'");
  },
  // 6: 申請者の名前（AIの自己申告）。古いコネクタは送らないので、空を許す。
  (db) => {
    const columns = all<{ name: string }>(db, "select name from pragma_table_info('decisions')").map((c) => c.name);
    if (!columns.includes("requester")) db.exec("alter table decisions add column requester text");
  },
  // 7: 削除対象の補助記録を所有者へ結び、保持原本を間引いた後も診断の帰属を残す。
  (db) => {
    const owned: [string, string][] = [
      ["events", "exists(select 1 from users where id=user_id)"],
      ["idempotency", "exists(select 1 from users where id=user_id)"],
      ["pairings", "(user_id is null or exists(select 1 from users where id=user_id)) and (connection_id is null or exists(select 1 from connections where id=connection_id))"],
      ["request_checks", "exists(select 1 from connections where id=connection_id)"],
      ["auth_flows", "link_user_id is null or exists(select 1 from users where id=link_user_id)"],
    ];
    for (const [name, predicate] of owned) {
      // 定義はschema一か所に置く。これらの表を参照する外部キーはない。
      const definition = schema.match(new RegExp(`create table if not exists ${name} \\([\\s\\S]*?\\n\\);`))![0];
      const sequence = get<{ seq: number }>(db, "select seq from sqlite_sequence where name=?", name)?.seq;
      db.exec(`alter table ${name} rename to deletion_legacy_${name}`);
      db.exec(definition);
      db.exec(`insert into ${name} select * from deletion_legacy_${name} where ${predicate}`);
      db.exec(`drop table deletion_legacy_${name}`);
      if (sequence !== undefined) {
        const updated = run(db, "update sqlite_sequence set seq=max(seq,?) where name=?", sequence, name);
        if (!updated.changes) run(db, "insert into sqlite_sequence(name,seq) values (?,?)", name, sequence);
      }
    }
    db.exec("create index if not exists events_user on events(user_id,id)");
    // 旧callbackの消費済みflowは所有者を復元できない。再利用不能であり、未使用のflowや発行済みアプリコードには影響しない。
    run(db, "delete from auth_flows where link_user_id is null and used_at is not null");
    db.exec(`insert or ignore into diagnostic_group_sources
      select d.fingerprint,d.user_id,count(*),min(d.received_at),max(d.received_at),
        (select latest.payload from diagnostics latest where latest.fingerprint=d.fingerprint and latest.user_id=d.user_id and latest.received_at>=g.first_seen order by latest.received_at desc,latest.id desc limit 1)
      from diagnostics d join diagnostic_groups g on g.fingerprint=d.fingerprint
      where d.received_at>=g.first_seen group by d.fingerprint,d.user_id`);
    // 原本が間引かれていても、最新payloadの所有者は長期保持の受領記録から復元できる。
    for (const group of all<{ fingerprint: string; first_seen: string; last_seen: string; payload: string }>(db, "select * from diagnostic_groups")) {
      const eventId = (JSON.parse(group.payload) as { event_id?: string }).event_id;
      for (const owner of all<{ user_id: string }>(db, "select user_id from diagnostic_receipts where event_id=? and payload_hash=?", eventId ?? "", hash(group.payload))) {
        run(db, "insert or ignore into diagnostic_group_sources values (?,?,0,?,?,?)", group.fingerprint, owner.user_id, group.first_seen, group.last_seen, group.payload);
      }
    }
    db.exec("delete from diagnostic_groups where not exists(select 1 from diagnostic_group_sources s where s.fingerprint=diagnostic_groups.fingerprint)");
    db.exec("delete from diagnostic_rate where scope<>'global' and not exists(select 1 from users where id=scope)");
  },
];

function migrate(db: Db) {
  const version = (get<{ user_version: number }>(db, "pragma user_version")?.user_version) ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("begin immediate");
    try {
      MIGRATIONS[i]!(db);
      db.exec(`pragma user_version = ${i + 1}`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
}

export function get<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

const depth = new WeakMap<Db, number>();
const committed = new WeakMap<Db, (() => void)[]>();
/** 通知など、外へ見える処理は外側取引のcommit後だけ実行する。 */
export function afterCommit(db: Db, fn: () => void) {
  const pending = committed.get(db);
  if (pending) pending.push(fn); else fn();
}

/** 書き込みの取引。入れ子で呼ばれたら外側の取引に乗る。 */
export function tx<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try { return fn(); } finally { depth.set(db, level); }
  }
  db.exec("begin immediate");
  depth.set(db, 1);
  committed.set(db, []);
  try {
    const result = fn();
    db.exec("commit");
    const hooks = committed.get(db)!;
    committed.delete(db);
    depth.delete(db);
    for (const hook of hooks) { try { hook(); } catch (error) { console.error("Committed event listener failed", error); } }
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  } finally {
    committed.delete(db);
    depth.set(db, 0);
  }
}
