// 利用者IDを、共有ライブラリの K へ付け替える（一度きり）。形は docs/architecture/login-pass.md「付け替え」。
// 確かめる条件のどれかが外れたら、何も変えずに失敗の名前だけ返す（ID・件数は返さない）。
import { PLAY_PAID_STATES } from "./accounts.ts";
import { type Db, all, get, run } from "./db.ts";
import { now } from "./ids.ts";

const DONE_KEY = "rekey:done";
type Provider = "apple" | "google";
export type RekeyResult = { deleted: number; rekeyed: number } | { failed: string };

/** users(id) を持つ全ての列。表の定義から引くので、後から足した表も漏れない。 */
function userColumns(db: Db): [table: string, column: string][] {
  const found = new Map<string, [string, string]>();
  for (const { name } of all<{ name: string }>(db, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")) {
    for (const column of all<{ name: string }>(db, `select name from pragma_table_info('${name}')`)) {
      if (column.name === "user_id" || column.name === "link_user_id") found.set(`${name}.${column.name}`, [name, column.name]);
    }
    for (const fk of all<{ from: string; table: string }>(db, `select "from", "table" from pragma_foreign_key_list('${name}')`)) {
      if (fk.table === "users") found.set(`${name}.${fk.from}`, [name, fk.from]);
    }
  }
  found.delete("users.id");
  return [...found.values()];
}

/**
 * 前提を1つの取引の中で確かめてから付け替える。
 * (a) 削除するもの以外の利用者は、identities を1行ずつ持つ。
 * (b) identities の無い利用者は、deleteIds と同じ集合で、中身（申請・端末・セットアップ確認・契約）が空。
 * (c) 今も払い済みの契約の行が無い。
 * 付け替えは、K = 提供元とsubjectから導く値を、利用者IDを持つ全ての表で入れ替える。
 */
export async function rekeyToK(db: Db, deriveK: (provider: Provider, subject: string) => Promise<string>, deleteList: string[]): Promise<RekeyResult> {
  const deleteIds = [...new Set(deleteList)];
  const done = get<{ value: string }>(db, "select value from lb_kv where key = ?", DONE_KEY);
  if (done) return JSON.parse(done.value) as RekeyResult;
  // K の計算は非同期なので取引の前に済ませ、取引の中では、読み直した identities が全部計算済みかを確かめる。
  const keyOf = (i: { provider: string; subject: string }) => `${i.provider}\0${i.subject}`;
  const ks = new Map<string, string>();
  for (const i of all<{ provider: Provider; subject: string }>(db, "select provider, subject from identities")) ks.set(keyOf(i), await deriveK(i.provider, i.subject));

  db.exec("begin immediate");
  try {
    const failed = check(db, ks, keyOf, new Set(deleteIds));
    if (failed) { db.exec("rollback"); return { failed }; }
    // 外部キーは、付け替えの途中（親だけ替わった状態）を許すよう、commitの時にまとめて確かめる。
    db.exec("pragma defer_foreign_keys = on");
    const columns = userColumns(db);
    for (const id of deleteIds) {
      for (const [table, column] of columns) run(db, `delete from ${table} where ${column} = ?`, id);
      run(db, "delete from users where id = ?", id);
    }
    const owners = all<{ provider: string; subject: string; user_id: string }>(db, "select provider, subject, user_id from identities");
    for (const owner of owners) {
      const k = ks.get(keyOf(owner))!;
      if (k === owner.user_id) continue;
      for (const [table, column] of columns) run(db, `update ${table} set ${column} = ? where ${column} = ?`, k, owner.user_id);
      run(db, "update users set id = ? where id = ?", k, owner.user_id);
    }
    if (all(db, "pragma foreign_key_check").length) throw new Error("foreign_key_check");
    const result = { deleted: deleteIds.length, rekeyed: owners.length };
    run(db, "insert into lb_kv (key, value, expires_at) values (?, ?, ?)", DONE_KEY, JSON.stringify(result), Number.MAX_SAFE_INTEGER); // 期限なし。掃除に消されない
    db.exec("commit");
    return result;
  } catch {
    db.exec("rollback");
    return { failed: "error" };
  }
}

/** 失敗した確認の名前。全部通れば undefined。 */
function check(db: Db, ks: Map<string, string>, keyOf: (i: { provider: string; subject: string }) => string, deleteSet: Set<string>): string | undefined {
  const identities = all<{ provider: string; subject: string; user_id: string }>(db, "select provider, subject, user_id from identities");
  if (identities.some((i) => !ks.has(keyOf(i)))) return "identities";
  const perUser = new Map<string, number>();
  for (const i of identities) perUser.set(i.user_id, (perUser.get(i.user_id) ?? 0) + 1);
  const users = all<{ id: string }>(db, "select id from users").map((u) => u.id);
  const noIdentity = users.filter((id) => !perUser.has(id));
  if (noIdentity.length !== deleteSet.size || !noIdentity.every((id) => deleteSet.has(id))) return "delete_set";
  if (users.some((id) => !deleteSet.has(id) && perUser.get(id) !== 1)) return "identities";
  for (const id of deleteSet) {
    const used = ["decisions", "devices", "setup_checks", "appstore_subscriptions", "play_subscriptions"].some((table) => get(db, `select 1 from ${table} where user_id = ?`, id));
    if (used) return "delete_set_content";
  }
  const at = now();
  const live = get(db, "select 1 from appstore_subscriptions where revoked = 0 and expires_at > ?", at)
    || all<{ state: string }>(db, "select state from play_subscriptions where expires_at > ?", at).some((r) => PLAY_PAID_STATES.has(r.state));
  return live ? "live_subscription" : undefined;
}

const PURGE_KEY = "purge:legacy:done";
/** ライブラリだけで動く時に消す、旧いログインと契約の行（表は残す。セルフホストの形は変えない）。 */
const PURGE: [table: string, where: string][] = [
  ["identities", ""], ["auth_flows", ""], ["login_links", ""], ["appstore_subscriptions", ""], ["play_subscriptions", ""], ["sessions", " where client is null"],
];
export type PurgeResult = Record<string, number> | { failed: string };

/**
 * 旧いログインと契約の行を一度だけ消す（login-pass.md「library-only mode」）。rekeyToK が済んだ後に呼ぶ。
 * 1つの取引で消し、件数を lb_kv の印（期限なし）に残す。2回目からは印の件数を返すだけ。失敗したら何も消さない。
 */
export function purgeLegacy(db: Db): PurgeResult {
  const done = get<{ value: string }>(db, "select value from lb_kv where key = ?", PURGE_KEY);
  if (done) return JSON.parse(done.value) as PurgeResult;
  db.exec("begin immediate");
  try {
    const counts: Record<string, number> = {};
    for (const [table, where] of PURGE) counts[table] = Number(run(db, `delete from ${table}${where}`).changes);
    run(db, "insert into lb_kv (key, value, expires_at) values (?, ?, ?)", PURGE_KEY, JSON.stringify(counts), Number.MAX_SAFE_INTEGER); // 期限なし。掃除に消されない
    db.exec("commit");
    return counts;
  } catch {
    db.exec("rollback");
    return { failed: "error" };
  }
}
