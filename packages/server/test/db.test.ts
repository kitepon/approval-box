import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { all, openDb } from "../src/db.ts";
import { Accounts } from "../src/accounts.ts";
import { EventHub } from "../src/events.ts";

test("スキーマに同じ表を二度書かない（古い定義が残ると、既にあるDBでは新しい定義が飛ばされる）", () => {
  const source = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const names = [...source.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

test("最初の形のdevices表を持つDBを開くと、行を保ったまま新しい形へ移り、登録できる", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ab-db-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`create table users (id text primary key, created_at text not null, setup_verified_at text, retention_days integer not null default 30, plan text not null default 'trial', plan_expires_at text, store text);
    create table devices (id text primary key, user_id text not null references users(id) on delete cascade, platform text not null, apns_token text, apns_env text, fcm_token text, web_push_subscription text, created_at text not null);
    insert into users (id, created_at) values ('u1', '2026-10-01T00:00:00Z');
    insert into devices values ('d1', 'u1', 'ios', 'tok', 'sandbox', null, null, '2026-10-01T00:00:00Z');`);
  old.close();
  const db = openDb(file);
  assert.deepEqual(all<{ id: string; push_key: string }>(db, "select id, push_key from devices").map((r) => r.id), ["d1"]);
  const accounts = new Accounts(db, new EventHub(db), "off");
  assert.equal(accounts.registerDevice("u1", { platform: "ios", apns_token: "tok", apns_env: "production" }).id, "d1");
  assert.ok(accounts.registerDevice("u1", { platform: "ios", apns_token: "0".repeat(64), apns_env: "sandbox" }).id);
  db.close();
  const again = openDb(file); // 二度目に開いても移し直さない
  assert.equal(all(again, "select * from devices").length, 2);
});
