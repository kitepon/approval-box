import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const schema = `
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
create table if not exists personal_links (
  user_id text primary key references users(id) on delete cascade,
  key_hash text not null unique,
  created_at text not null,
  last_used_at text
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
  user_id text,
  connection_id text,
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
  user_id text not null,
  type text not null,
  data text not null,
  at text not null
);
create index if not exists events_user on events(user_id, id);
create table if not exists idempotency (
  user_id text not null,
  key text not null,
  route text not null,
  status integer not null,
  body text not null,
  created_at text not null,
  primary key (user_id, key)
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
create table if not exists devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  platform text not null,
  apns_token text,
  apns_env text,
  fcm_token text,
  web_push_subscription text,
  created_at text not null
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec(schema);
  return db;
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

/** 書き込みの取引。入れ子で呼ばれたら外側の取引に乗る。 */
export function tx<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try { return fn(); } finally { depth.set(db, level); }
  }
  db.exec("begin immediate");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  } finally {
    depth.set(db, 0);
  }
}
