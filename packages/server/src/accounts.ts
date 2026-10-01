import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { hash, normalizePairingCode, now, pairingCode, secret, uuid } from "./ids.ts";
import type { Connection } from "./decisions.ts";

const SESSION_DAYS = 90;
const PAIRING_MINUTES = 10;
const LOGIN_LINK_MINUTES = 15;

type UserRow = { id: string; created_at: string; setup_verified_at: string | null; retention_days: number; plan: string; plan_expires_at: string | null; store: string | null };
type ConnectionRow = { id: string; user_id: string; kind: string; label: string; os: string | null; clients: string; created_at: string; last_seen_at: string | null; revoked_at: string | null };
type PairingRow = { id: string; code: string; poll_secret_hash: string; device_name: string; os: string | null; clients: string; status: string; user_id: string | null; connection_id: string | null; token: string | null; created_at: string; expires_at: string };
type CheckRow = { connection_id: string; client: string; os: string | null; status: string; decision_id: string | null; passed_at: string | null; tested_at: string | null; failed_step: string | null; detail: string | null };

export type BillingMode = "off" | "store";

export class Accounts {
  private readonly db: Db;
  private readonly events: EventHub;
  private readonly billing: BillingMode;

  constructor(db: Db, events: EventHub, billing: BillingMode) {
    this.db = db;
    this.events = events;
    this.billing = billing;
  }

  // ---- 利用者とsession ----

  createUser(): string {
    const id = uuid();
    run(this.db, "insert into users (id, created_at) values (?, ?)", id, now());
    return id;
  }

  issueSession(userId: string, label: string): { session: string; expires_at: string } {
    const session = secret("kss");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    run(this.db, "insert into sessions (token_hash, user_id, label, created_at, expires_at) values (?, ?, ?, ?, ?)", hash(session), userId, label, now(), expires);
    return { session, expires_at: expires };
  }

  userBySession(session: string | undefined): string {
    if (!session) throw new ApiError("unauthorized", "ログインしてください。");
    const row = get<{ user_id: string; expires_at: string }>(this.db, "select user_id, expires_at from sessions where token_hash = ?", hash(session));
    if (!row || row.expires_at < now()) throw new ApiError("unauthorized", "ログインの期限が切れました。もう一度ログインしてください。");
    return row.user_id;
  }

  /** 一度だけ使えるログインのリンク。Apple・Googleのログインが無いサーバーで、管理者が利用者へ渡す。コードはURLの#の後ろに置き、サーバーのログに残さない。 */
  createLoginLink(userId: string, label: string, publicUrl: string): { url: string; expires_at: string } {
    if (!get(this.db, "select 1 from users where id = ?", userId)) throw new ApiError("not_found", "その利用者はいません。");
    const code = secret("kll");
    const expires = new Date(Date.now() + LOGIN_LINK_MINUTES * 60_000).toISOString();
    run(this.db, "insert into login_links (code_hash, user_id, label, created_at, expires_at) values (?, ?, ?, ?, ?)", hash(code), userId, label, now(), expires);
    return { url: `${publicUrl}/login#code=${code}`, expires_at: expires };
  }

  /**
   * 外部のログイン（Apple・Google）で入る。結ばれたアカウントがあればそこへ、無ければ作る。
   * ログイン済み（currentUserId あり）で呼ばれたら、そのアカウントにこのIDを結ぶ（既存アカウントへ「Appleでログインを追加」）。
   */
  signInWithIdentity(provider: "apple" | "google", subject: string, email: string | undefined, currentUserId: string | undefined) {
    return tx(this.db, () => {
      const linked = get<{ user_id: string }>(this.db, "select user_id from identities where provider = ? and subject = ?", provider, subject);
      const name = provider === "apple" ? "Apple ID" : "Googleアカウント";
      if (linked && currentUserId && linked.user_id !== currentUserId) {
        throw new ApiError("conflict", `この${name}は、別のApproval Boxのアカウントで使われています。`);
      }
      // 1つのアカウントはGoogleかAppleのどちらか1つのIDに結ぶ（クオの裁定）。結べるのは、まだIDの無いアカウントだけ。
      if (!linked && currentUserId && get(this.db, "select 1 from identities where user_id = ?", currentUserId)) {
        throw new ApiError("conflict", "このアカウントは既に別のIDでログインしています。1つのアカウントに結べるIDは1つだけです。");
      }
      const userId = linked?.user_id ?? currentUserId ?? this.createUser();
      if (!linked) run(this.db, "insert into identities (provider, subject, user_id, email, created_at) values (?, ?, ?, ?, ?)", provider, subject, userId, email ?? null, now());
      return { ...this.issueSession(userId, provider), user: { id: userId } };
    });
  }

  /**
   * 利用者ごとに固定のログインURL（何度でも使える。ブックマーク用）。作り直すと前のURLは使えなくなる。
   * URLを知っていれば誰でもログインできるので、本人だけが持つ。値は保存しない（作った時に一度だけ返す）。
   */
  createPersonalLink(userId: string, publicUrl: string): { url: string; created_at: string } {
    const key = secret("kpl");
    const created = now();
    run(this.db, "insert into personal_links (user_id, key_hash, created_at) values (?, ?, ?) on conflict(user_id) do update set key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = null",
      userId, hash(key), created);
    return { url: `${publicUrl}/login#code=${key}`, created_at: created };
  }

  personalLink(userId: string) {
    const row = get<{ created_at: string; last_used_at: string | null }>(this.db, "select created_at, last_used_at from personal_links where user_id = ?", userId);
    return row ? { exists: true, created_at: row.created_at, last_used_at: row.last_used_at } : { exists: false };
  }

  revokePersonalLink(userId: string) {
    run(this.db, "delete from personal_links where user_id = ?", userId);
  }

  redeemLoginLink(code: string): { session: string; expires_at: string } {
    if (code.startsWith("kpl_")) {
      const row = get<{ user_id: string }>(this.db, "select user_id from personal_links where key_hash = ?", hash(code));
      if (!row) throw new ApiError("unauthorized", "このログインのURLは使えません。作り直された可能性があります。");
      run(this.db, "update personal_links set last_used_at = ? where user_id = ?", now(), row.user_id);
      return this.issueSession(row.user_id, "personal-link");
    }
    return tx(this.db, () => {
      const row = get<{ user_id: string; label: string | null; expires_at: string; used_at: string | null }>(this.db, "select user_id, label, expires_at, used_at from login_links where code_hash = ?", hash(code));
      if (!row || row.used_at || row.expires_at < now()) throw new ApiError("unauthorized", "このログインのリンクは使えません。期限切れか、もう使われています。");
      run(this.db, "update login_links set used_at = ? where code_hash = ?", now(), hash(code));
      return this.issueSession(row.user_id, row.label ?? "login-link");
    });
  }

  revokeSession(session: string) {
    run(this.db, "delete from sessions where token_hash = ?", hash(session));
  }

  deleteUser(userId: string) {
    run(this.db, "delete from users where id = ?", userId);
  }

  me(userId: string) {
    const user = get<UserRow>(this.db, "select * from users where id = ?", userId);
    if (!user) throw new ApiError("unauthorized", "アカウントが見つかりません。");
    const checks = all<CheckRow>(this.db, "select * from setup_checks where user_id = ? order by client", userId).map((c) => ({
      connection_id: c.connection_id, client: c.client, ...(c.os ? { os: c.os } : {}), status: c.status,
      ...(c.decision_id ? { decision_id: c.decision_id } : {}), ...(c.passed_at ? { passed_at: c.passed_at } : {}),
      ...(c.tested_at ? { tested_at: c.tested_at } : {}), ...(c.failed_step ? { failed_step: c.failed_step } : {}), ...(c.detail ? { detail: c.detail } : {}),
    }));
    // セットアップ確認をしていない組み合わせ（接続に登録したAIでまだテストしていないもの）も並べる。
    for (const conn of this.connections(userId)) {
      for (const client of conn.clients) {
        if (!checks.some((c) => c.connection_id === conn.id && c.client === client)) {
          checks.push({ connection_id: conn.id, client, ...(conn.os ? { os: conn.os } : {}), status: "untested" });
        }
      }
    }
    // セルフホスト（課金なし）は全員を契約中として扱う。
    const plan = this.billing === "off" ? "active" : user.plan;
    const login = get<{ provider: string }>(this.db, "select provider from identities where user_id = ?", userId);
    return {
      user_id: user.id,
      login: login?.provider ?? null,
      setup: { verified: !!user.setup_verified_at, ...(user.setup_verified_at ? { verified_at: user.setup_verified_at } : {}), checks },
      plan,
      ...(user.plan_expires_at && this.billing !== "off" ? { expires_at: user.plan_expires_at } : {}),
      ...(user.store && this.billing !== "off" ? { store: user.store } : {}),
      billing: this.billing,
    };
  }

  settings(userId: string) {
    const row = get<{ retention_days: number }>(this.db, "select retention_days from users where id = ?", userId)!;
    return { retention_days: row.retention_days };
  }

  updateSettings(userId: string, retentionDays: number) {
    run(this.db, "update users set retention_days = ? where id = ?", retentionDays, userId);
    return this.settings(userId);
  }

  assertCanUse(userId: string) {
    if (this.billing === "off") return;
    const user = get<UserRow>(this.db, "select * from users where id = ?", userId)!;
    if (user.plan === "expired") throw new ApiError("subscription_expired", "Approval Boxの契約が切れています。アプリかWeb版の契約画面から更新してください。");
  }

  assertSetupVerified(userId: string) {
    const user = get<UserRow>(this.db, "select * from users where id = ?", userId)!;
    if (!user.setup_verified_at) throw new ApiError("setup_not_verified", "セットアップ確認がまだです。AIに「Approval Boxのsetup_testを実行して」と言って、答えがAIまで届くことを確かめてから契約してください。");
  }

  // ---- 接続（端末・リモート）----

  connections(userId: string) {
    return all<ConnectionRow>(this.db, "select * from connections where user_id = ? and revoked_at is null order by created_at", userId).map((c) => ({
      id: c.id, kind: c.kind === "token" ? "device" : c.kind, label: c.label, ...(c.os ? { os: c.os } : {}), clients: JSON.parse(c.clients) as string[],
      created_at: c.created_at, ...(c.last_seen_at ? { last_seen_at: c.last_seen_at } : {}),
    }));
  }

  createConnection(userId: string, label: string, os: string | null, clients: string[], kind: "device" | "token" = "device") {
    const id = uuid();
    const token = secret("kbt");
    run(this.db, "insert into connections (id, user_id, kind, label, os, clients, token_hash, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id, userId, kind, label, os, JSON.stringify(clients), hash(token), now());
    return { id, token };
  }

  // ---- 通知を受ける端末（アプリ・Web Push）。同じ宛先（tokenやsubscription）は同じidに上書きする ----

  registerDevice(userId: string, input: { platform: "ios" | "android" | "web"; apns_token?: string; apns_env?: "sandbox" | "production"; fcm_token?: string; web_push_subscription?: unknown }) {
    const subscription = input.web_push_subscription === undefined ? null : JSON.stringify(input.web_push_subscription);
    const key = input.platform === "ios" ? input.apns_token : input.platform === "android" ? input.fcm_token : subscription;
    if (!key) throw new ApiError("validation_failed", input.platform === "ios" ? "apns_token が要ります。" : input.platform === "android" ? "fcm_token が要ります。" : "web_push_subscription が要ります。");
    const pushKey = `${input.platform}:${hash(key)}`;
    const existing = get<{ id: string }>(this.db, "select id from devices where user_id = ? and push_key = ?", userId, pushKey);
    const id = existing?.id ?? uuid();
    run(this.db, `insert into devices (id, user_id, platform, push_key, apns_token, apns_env, fcm_token, web_push_subscription, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, push_key) do update set apns_env = excluded.apns_env, updated_at = excluded.updated_at`,
      id, userId, input.platform, pushKey, input.apns_token ?? null, input.apns_env ?? null, input.fcm_token ?? null, subscription, now(), now());
    return { id };
  }

  removeDevice(userId: string, id: string) {
    const result = run(this.db, "delete from devices where id = ? and user_id = ?", id, userId);
    if (!result.changes) throw new ApiError("not_found", "その端末は見つかりません。");
  }

  // ---- 接続トークン（画面の無い端末で npx approval-box setup --token に渡す）。中身は接続そのもので、ペアリングを省いたもの ----

  issueToken(userId: string, label: string, publicUrl: string) {
    const conn = this.createConnection(userId, label, null, [], "token");
    this.events.publish(userId, "setup.updated", {});
    return { id: conn.id, token: conn.token, setup_command: `npx -y approval-box@latest setup --server ${publicUrl} --token ${conn.token}` };
  }

  tokens(userId: string) {
    return all<ConnectionRow>(this.db, "select * from connections where user_id = ? and kind = 'token' and revoked_at is null order by created_at", userId)
      .map((c) => ({ id: c.id, label: c.label, created_at: c.created_at, last_used_at: c.last_seen_at ?? null }));
  }

  revokeToken(userId: string, id: string) {
    if (!get(this.db, "select 1 from connections where id = ? and user_id = ? and kind = 'token' and revoked_at is null", id, userId)) throw new ApiError("not_found", "そのトークンは見つかりません。");
    this.revokeConnection(userId, id);
  }

  revokeConnection(userId: string, id: string) {
    const result = run(this.db, "update connections set revoked_at = ?, token_hash = null where id = ? and user_id = ? and revoked_at is null", now(), id, userId);
    if (!result.changes) throw new ApiError("not_found", "その接続は見つかりません。");
    run(this.db, "delete from setup_checks where connection_id = ?", id);
  }

  connectionByToken(token: string | undefined): Connection {
    if (!token) throw new ApiError("unauthorized", "接続トークンがありません。npx -y approval-box@latest setup をやり直してください。");
    const row = get<ConnectionRow>(this.db, "select * from connections where token_hash = ? and revoked_at is null", hash(token));
    if (!row) throw new ApiError("unauthorized", "この端末の接続は外されています。npx -y approval-box@latest setup でつなぎ直してください。");
    run(this.db, "update connections set last_seen_at = ? where id = ?", now(), row.id);
    return { id: row.id, user_id: row.user_id, label: row.label, os: row.os };
  }

  updateConnectionClients(conn: Connection, clients: string[], os?: string) {
    run(this.db, "update connections set clients = ?, os = coalesce(?, os) where id = ?", JSON.stringify(clients), os ?? null, conn.id);
    this.events.publish(conn.user_id, "setup.updated", {});
  }

  connectionInfo(conn: Connection) {
    const row = get<ConnectionRow>(this.db, "select * from connections where id = ?", conn.id)!;
    return { connection_id: row.id, label: row.label, os: row.os, clients: JSON.parse(row.clients) as string[], me: this.me(row.user_id) };
  }

  // ---- ペアリング ----

  startPairing(deviceName: string, os: string | null, clients: string[], publicUrl: string) {
    const id = uuid();
    const pollSecret = secret("kps");
    let code = pairingCode();
    while (get(this.db, "select 1 from pairings where code = ?", code)) code = pairingCode();
    const expires = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
    run(this.db, "insert into pairings (id, code, poll_secret_hash, device_name, os, clients, status, created_at, expires_at) values (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)",
      id, code, hash(pollSecret), deviceName, os, JSON.stringify(clients), now(), expires);
    return { pairing_id: id, code, qr_url: `${publicUrl}/pair?c=${code}`, poll_secret: pollSecret, expires_at: expires };
  }

  lookupPairing(codeInput: string) {
    const code = normalizePairingCode(codeInput);
    if (!code) throw new ApiError("validation_failed", "コードは英字と数字の8文字です。");
    const row = get<PairingRow>(this.db, "select * from pairings where code = ?", code);
    if (!row || row.status !== "waiting" || row.expires_at < now()) throw new ApiError("not_found", "そのコードは見つからないか、期限が切れています。PCで npx -y approval-box@latest setup をやり直してください。");
    return { pairing_id: row.id, device_name: row.device_name, ...(row.os ? { os: row.os } : {}), clients: JSON.parse(row.clients) as string[], expires_at: row.expires_at };
  }

  claimPairing(userId: string, id: string) {
    return tx(this.db, () => {
      const row = get<PairingRow>(this.db, "select * from pairings where id = ?", id);
      if (!row || row.status !== "waiting" || row.expires_at < now()) throw new ApiError("not_found", "このペアリングは期限が切れています。PCで npx -y approval-box@latest setup をやり直してください。");
      const conn = this.createConnection(userId, row.device_name, row.os, JSON.parse(row.clients));
      // tokenはPC側が一度取りに来るまでだけ置く。取りに来たら消す。
      run(this.db, "update pairings set status = 'claimed', user_id = ?, connection_id = ?, token = ? where id = ?", userId, conn.id, conn.token, id);
      this.events.publish(userId, "setup.updated", {});
      return { connection_id: conn.id };
    });
  }

  rejectPairing(userId: string, id: string) {
    run(this.db, "update pairings set status = 'rejected', user_id = ? where id = ? and status = 'waiting'", userId, id);
  }

  pollPairing(id: string, pollSecret: string | undefined) {
    const row = get<PairingRow>(this.db, "select * from pairings where id = ?", id);
    if (!row || !pollSecret || row.poll_secret_hash !== hash(pollSecret)) throw new ApiError("not_found", "そのペアリングは見つかりません。");
    if (row.status === "claimed" && row.token) {
      run(this.db, "update pairings set token = null, status = 'delivered' where id = ?", id);
      return { status: "claimed" as const, token: row.token, connection_id: row.connection_id! };
    }
    if (row.status === "rejected") return { status: "rejected" as const };
    if (row.status === "delivered") return { status: "delivered" as const };
    if (row.expires_at < now()) return { status: "expired" as const };
    return { status: "waiting" as const };
  }

  prunePairings() {
    run(this.db, "delete from pairings where expires_at < ?", new Date(Date.now() - 86400_000).toISOString());
    run(this.db, "delete from login_links where expires_at < ?", new Date(Date.now() - 86400_000).toISOString());
  }
}
