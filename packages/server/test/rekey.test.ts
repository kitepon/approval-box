import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deriveKWith } from "@kitepon/login-billing/server";
import { Accounts } from "../src/accounts.ts";
import { type Db, all, get, openDb, run } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { purgeLegacy, rekeyToK } from "../src/rekey.ts";

const kKey = randomBytes(32);
const deriveK = (provider: "apple" | "google", subject: string) => deriveKWith(kKey, provider, subject);
const at = "2026-11-20T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

/** 全ての表の全ての行。付け替えに失敗した時に、何も変わっていないことを確かめる。 */
function dump(db: Db) {
  const out: Record<string, unknown> = {};
  for (const { name } of all<{ name: string }>(db, "select name from sqlite_master where type = 'table' order by name")) out[name] = all(db, `select * from ${name} order by rowid`);
  return JSON.stringify([out, get(db, "pragma user_version")]);
}

/** 利用者IDを持つ表それぞれに、行がある状態。実在の3人（apple a1・google g1・apple a2）と、identitiesの無いテスト用8人。 */
function fixture() {
  const db = openDb(":memory:");
  const accounts = new Accounts(db, new EventHub(db), "store");
  const real = (["apple:a1", "google:g1", "apple:a2"] as const).map((key) => {
    const [provider, subject] = key.split(":") as ["apple" | "google", string];
    return { provider, subject, id: accounts.signInWithIdentity(provider, subject).user.id };
  });
  const empties = Array.from({ length: 8 }, () => accounts.createUser());
  for (const [i, id] of [...real.map((r) => r.id), ...empties].entries()) {
    const connection = accounts.createConnection(id, `pc-${i}`, "linux", []).id;
    accounts.issueSession(id, "t");
    run(db, "insert into pairings (id, code, poll_secret_hash, device_name, status, user_id, connection_id, created_at, expires_at) values (?, ?, 'h', 'd', 'claimed', ?, ?, ?, ?)", `p${i}`, `AAAA-000${i}`, id, connection, at, at);
    run(db, "insert into auth_flows (state, provider, nonce, link_user_id, code_challenge, created_at, expires_at) values (?, 'apple', 'n', ?, 'c', ?, ?)", `s${i}`, id, at, at);
    run(db, "insert into login_links (code_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)", `l${i}`, id, at, at);
    run(db, "insert into events (user_id, type, data, at) values (?, 'x', '{}', ?)", id, at);
    run(db, "insert into idempotency (user_id, key, route, status, body, created_at) values (?, 'k', 'r', 200, '{}', ?)", id, at);
    run(db, "insert into request_uploads (id, user_id, connection_id, name, content_type, kind, size, sha256, created_at) values (?, ?, ?, 'n', 'image/png', 'image', 1, 'h', ?)", `u${i}`, id, connection, at);
  }
  for (const [i, r] of real.entries()) {
    accounts.registerDevice(r.id, { platform: "ios", apns_token: `token-${i}` });
    run(db, `insert into decisions (id, user_id, title, norm_title, context, options, urgency, client, session_label, via, status, resume_phrase, created_at, updated_at, version)
      values (?, ?, 't', 't', '', '[]', 'normal', 'c', 's', 'connector', 'pending', 'r', ?, ?, 1)`, `K-REAL${i}`, r.id, at, at);
    run(db, "insert into history (decision_id, at, kind, by) values (?, ?, 'created', 'ai')", `K-REAL${i}`, at);
    run(db, "insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, created_at) values (?, ?, ?, 'n', 'image/png', 'image', 1, 'h', ?)", `a${i}`, r.id, `K-REAL${i}`, at);
    run(db, "insert into setup_checks (id, user_id, connection_id, client, status) values (?, ?, ?, 'claude-code', 'untested')", `c${i}`, r.id, `conn${i}`);
    // 切れた契約は付け替えを止めない。
    run(db, "insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, updated_at) values (?, ?, 'Production', 'p', '2020-01-01T00:00:00.000Z', ?)", `o${i}`, r.id, at);
    run(db, "insert into play_subscriptions (purchase_token, user_id, product_id, state, expires_at, updated_at) values (?, ?, 'p', 'EXPIRED', '2020-01-01T00:00:00.000Z', ?)", `t${i}`, r.id, at);
  }
  return { db, accounts, real, empties };
}

test("付け替え: 削除する8人とその中身を消し、実在の利用者のIDを、IDを持つ全ての表で K へ替える", async () => {
  const { db, real, empties } = fixture();
  const ks = await Promise.all(real.map((r) => deriveK(r.provider, r.subject)));
  assert.deepEqual(await rekeyToK(db, deriveK, empties), { deleted: 8, rekeyed: 3 });
  assert.deepEqual(all<{ id: string }>(db, "select id from users order by id").map((u) => u.id), [...ks].sort());
  const columns = all<{ t: string; c: string }>(db, `select m.name t, p.name c from sqlite_master m, pragma_table_info(m.name) p where m.type = 'table' and p.name in ('user_id', 'link_user_id')`);
  assert.ok(columns.length >= 14);
  const old = new Set([...real.map((r) => r.id), ...empties]);
  for (const { t, c } of columns) {
    const values = all<{ v: string }>(db, `select ${c} v from ${t} where ${c} is not null`).map((r) => r.v);
    assert.ok(values.length >= 3, `${t}.${c}`); // 実在の3人の行は残る
    assert.ok(values.every((v) => ks.includes(v)), `${t}.${c}`);
    assert.ok(!values.some((v) => old.has(v)));
  }
  assert.equal(get<{ n: number }>(db, "select count(*) n from sessions")?.n, 6); // 実在の3人が2つずつ
  assert.equal(get<{ n: number }>(db, "select count(*) n from connections")?.n, 3);
  assert.equal(get<{ n: number }>(db, "select count(*) n from history")?.n, 3); // 申請の履歴は申請に付いたまま
  assert.deepEqual(all(db, "pragma foreign_key_check"), []);
  assert.equal(get<{ id: string }>(db, "select user_id id from identities where provider = 'google' and subject = 'g1'")?.id, ks[1]);
  // 二度目は何もしない（印は期限なしで残り、掃除でも消えない）。
  const after = dump(db);
  assert.deepEqual(await rekeyToK(db, deriveK, empties), { deleted: 8, rekeyed: 3 });
  run(db, "delete from lb_kv where expires_at <= ?", Date.now());
  assert.equal(dump(db), after);
  assert.equal(get<{ n: number }>(db, "select count(*) n from lb_kv where key = 'rekey:done'")?.n, 1);
});

test("付け替え: 空のデータベースは、削除する人が無ければ何もせず成功する", async () => {
  const db = openDb(":memory:");
  assert.deepEqual(await rekeyToK(db, deriveK, []), { deleted: 0, rekeyed: 0 });
});

const failures: [string, string, (f: ReturnType<typeof fixture>) => string[] | void][] = [
  ["identitiesの無い利用者が、削除する一覧に無い", "delete_set", (f) => { f.accounts.createUser(); }],
  ["削除する一覧のIDが、実在しない", "delete_set", (f) => [...f.empties, "00000000-0000-4000-8000-000000000000"]],
  ["削除する一覧が、identitiesを持つ利用者を含む", "delete_set", (f) => [...f.empties.slice(1), f.real[0]!.id]],
  ["削除する人に申請がある", "delete_set_content", (f) => { run(f.db, "insert into decisions (id, user_id, title, norm_title, context, options, urgency, client, session_label, via, status, resume_phrase, created_at, updated_at, version) values ('K-EMPTY', ?, 't', 't', '', '[]', 'normal', 'c', 's', 'connector', 'answered', 'r', ?, ?, 1)", f.empties[0]!, at, at); }],
  ["削除する人に端末がある", "delete_set_content", (f) => { f.accounts.registerDevice(f.empties[1]!, { platform: "android", fcm_token: "t" }); }],
  ["削除する人にセットアップ確認がある", "delete_set_content", (f) => { run(f.db, "insert into setup_checks (id, user_id, connection_id, client, status) values ('cx', ?, 'connx', 'codex', 'untested')", f.empties[2]!); }],
  ["削除する人にApp Storeの契約の行がある", "delete_set_content", (f) => { run(f.db, "insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, updated_at) values ('ox', ?, 'Sandbox', 'p', '2020-01-01T00:00:00.000Z', ?)", f.empties[3]!, at); }],
  ["削除する人にGoogle Playの契約の行がある", "delete_set_content", (f) => { run(f.db, "insert into play_subscriptions (purchase_token, user_id, product_id, state, expires_at, updated_at) values ('tx', ?, 'p', 'EXPIRED', '2020-01-01T00:00:00.000Z', ?)", f.empties[4]!, at); }],
  ["利用者が2つのidentitiesを持つ", "identities", (f) => { run(f.db, "insert into identities (provider, subject, user_id, created_at) values ('google', 'second', ?, ?)", f.real[0]!.id, at); }],
  ["払い済みのApp Storeの契約がある", "live_subscription", (f) => { run(f.db, "update appstore_subscriptions set expires_at = ? where user_id = ?", FUTURE, f.real[1]!.id); }],
  ["払い済みのGoogle Playの契約がある", "live_subscription", (f) => { run(f.db, "update play_subscriptions set state = 'ACTIVE', expires_at = ? where user_id = ?", FUTURE, f.real[2]!.id); }],
];
for (const [name, failed, prepare] of failures) {
  test(`付け替えは前提が外れると、何も変えずに止まる: ${name}`, async () => {
    const f = fixture();
    const ids = prepare(f) ?? f.empties;
    const before = dump(f.db);
    assert.deepEqual(await rekeyToK(f.db, deriveK, ids), { failed });
    assert.equal(dump(f.db), before);
    assert.equal(get(f.db, "select 1 from lb_kv where key = 'rekey:done'"), undefined); // 印も付かない
  });
}

test("付け替えの途中で失敗しても、何も変えない（削除も付け替えも取引ごと戻る）", async () => {
  const f = fixture();
  const before = dump(f.db);
  f.db.exec("create trigger boom before update on users begin select raise(abort, 'boom'); end");
  assert.deepEqual(await rekeyToK(f.db, deriveK, f.empties), { failed: "error" });
  assert.equal(dump(f.db), before);
  assert.equal(get(f.db, "select 1 from lb_kv where key = 'rekey:done'"), undefined);
});

test("旧い行の一掃（library-only）: 付け替えの後に一度だけ、旧いログインと契約の行を消し、利用者・申請・接続・BellTeamのsessionは残す", async () => {
  const { db, accounts, real, empties } = fixture();
  await rekeyToK(db, deriveK, empties);
  const ks = await Promise.all(real.map((r) => deriveK(r.provider, r.subject)));
  for (const k of ks) accounts.issueSession(k, "bellteam", "bellteam"); // 登録クライアントのsession
  const count = (table: string) => get<{ n: number }>(db, `select count(*) n from ${table}`)!.n;
  const kept = () => ["users", "decisions", "history", "attachments", "connections", "devices", "setup_checks", "pairings", "events"].map((t) => [t, count(t)]);
  const before = kept();
  const counts = { identities: 3, auth_flows: 3, login_links: 3, appstore_subscriptions: 3, play_subscriptions: 3, sessions: 6 };
  assert.deepEqual(purgeLegacy(db), counts);
  for (const table of ["identities", "auth_flows", "login_links", "appstore_subscriptions", "play_subscriptions"]) assert.equal(count(table), 0, table);
  assert.deepEqual(all<{ client: string }>(db, "select client from sessions").map((r) => r.client), ["bellteam", "bellteam", "bellteam"]);
  assert.deepEqual(kept(), before);
  assert.deepEqual(all(db, "pragma foreign_key_check"), []);
  // 二度目は消さず、印の件数を返すだけ。付け替えも、空の identities を確かめ直さずに印の結果を返す。
  run(db, "insert into login_links (code_hash, user_id, created_at, expires_at) values ('later', ?, ?, ?)", ks[0], at, at);
  run(db, "delete from lb_kv where expires_at <= ?", Date.now());
  assert.deepEqual(purgeLegacy(db), counts);
  assert.equal(count("login_links"), 1);
  assert.deepEqual(await rekeyToK(db, deriveK, empties), { deleted: 8, rekeyed: 3 });
  assert.equal(get<{ n: number }>(db, "select count(*) n from lb_kv where key = 'purge:legacy:done'")?.n, 1);
});
