import type { Locale } from "./locales.ts";
import { createHash } from "node:crypto";
import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { hash, normalizePairingCode, now, pairingCode, secret, uuid } from "./ids.ts";
import type { Connection } from "./decisions.ts";
import { PRODUCT_ID } from "./lb.ts";

const SESSION_DAYS = 90;
// 利用者が席を外していても、戻った時にリンクを受け取れるようにする。
const PAIRING_DAYS = 7;
// 登録クライアント（BellTeamなど）の接続は、始めた直後に承認される前提なので短い。
const CLIENT_PAIRING_MINUTES = 15;
/** 登録クライアント。範囲付きsessionを受け取る。使えるAPIは http.ts の CLIENT_ROUTES。 */
export const CLIENTS: Record<string, string> = { bellteam: "BellTeam" };
const LOGIN_LINK_MINUTES = 15;

/** 期限を過ぎた契約は、更新の知らせが来るまで切れたものとして扱う。 */
function effectivePlan(user: { plan: string; plan_expires_at: string | null }): string {
  return user.plan === "active" && user.plan_expires_at && user.plan_expires_at <= new Date().toISOString() ? "expired" : user.plan;
}

type UserRow = { id: string; created_at: string; setup_verified_at: string | null; retention_days: number; plan: string; plan_expires_at: string | null; store: string | null };
type ConnectionRow = { id: string; user_id: string; kind: string; label: string; os: string | null; clients: string; created_at: string; last_seen_at: string | null; revoked_at: string | null };
type PairingRow = { id: string; code: string; poll_secret_hash: string; device_name: string; os: string | null; clients: string; status: string; user_id: string | null; connection_id: string | null; token: string | null; created_at: string; expires_at: string; client: string | null };
type CheckRow = { connection_id: string; client: string; os: string | null; status: string; decision_id: string | null; passed_at: string | null; tested_at: string | null; failed_step: string | null; detail: string | null };

export type BillingMode = "off" | "store";

/** Google Playで払い済みとして扱う契約の状態（保留・一時停止・失効は含めない）。docs/billing-play.md */
export const PLAY_PAID_STATES: ReadonlySet<string> = new Set(["ACTIVE", "IN_GRACE_PERIOD", "CANCELED"]);

export class Accounts {
  private readonly db: Db;
  private readonly events: EventHub;
  private readonly billing: BillingMode;

  /** 契約なしで使える、課金の対象外のアカウント（運営者のもの）。環境変数 FREE_ACCOUNT_IDS で渡す。 */
  private readonly freeAccountIds: ReadonlySet<string>;

  /** 期限切れのアカウントを me / assertCanUse が見た時の合図（App Storeが、更新の取りこぼしをAppleから読み直す）。待たない。 */
  onExpired?: (userId: string) => void;

  /** 共有ライブラリが覚えている、そのアカウントの契約（device の確認で更新される）。ライブラリを使わない時は無い。 */
  contract?: (userId: string) => "active" | "none" | "unknown";

  constructor(db: Db, events: EventHub, billing: BillingMode, freeAccountIds: ReadonlySet<string> = new Set()) {
    this.freeAccountIds = freeAccountIds;
    this.db = db;
    this.events = events;
    this.billing = billing;
  }

  // ---- 利用者とsession ----

  /** id は共有ライブラリのKで作る時だけ渡す（ensureUser）。 */
  createUser(id: string = uuid()): string {
    run(this.db, "insert or ignore into users (id, created_at, plan) values (?, ?, 'expired')", id, now()); // 製品は無料期間を持たない。使えるのはストアの契約から
    return id;
  }

  /** ライブラリの通行証で初めて来たKのアカウントを作る（あれば何もしない）。 */
  ensureUser(id: string) {
    if (!get(this.db, "select 1 from users where id = ?", id)) this.createUser(id);
  }

  issueSession(userId: string, label: string, client?: string): { session: string; expires_at: string } {
    const session = secret("kss");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    run(this.db, "insert into sessions (token_hash, user_id, label, created_at, expires_at, id, client) values (?, ?, ?, ?, ?, ?, ?)", hash(session), userId, label, now(), expires, uuid(), client ?? null);
    return { session, expires_at: expires };
  }

  /** `/v1` のBearer。登録クライアントのsessionは使うたびに期限を延ばす（使い続ける限り切れず、90日使わなければ承認からやり直す）。 */
  authenticate(session: string | undefined): { userId: string; client?: string; sessionId?: string } {
    if (!session) throw new ApiError("unauthorized", "ログインしてください。");
    const row = get<{ id: string | null; user_id: string; expires_at: string; client: string | null }>(this.db, "select id, user_id, expires_at, client from sessions where token_hash = ?", hash(session));
    if (!row || row.expires_at < now()) throw new ApiError("unauthorized", "ログインの期限が切れました。もう一度ログインしてください。");
    if (!row.client) return { userId: row.user_id };
    const renewed = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    // 書き込みは期限が30日以上縮んだ時だけ（毎回は書かない）。
    if (Date.parse(row.expires_at) < Date.parse(renewed) - 30 * 86400_000) run(this.db, "update sessions set expires_at = ? where token_hash = ?", renewed, hash(session));
    return { userId: row.user_id, client: row.client, sessionId: row.id! };
  }

  userBySession(session: string | undefined): string {
    return this.authenticate(session).userId;
  }

  clientSessionActive(id: string): boolean {
    return !!get(this.db, "select 1 from sessions where id = ? and expires_at >= ?", id, now());
  }

  // ---- ログインはAppleかGoogleだけ（クオの裁定）。ログイン用のURL・コードは無い ----
  // 例外は、ブラウザで始めるAppleのログイン（AndroidのCustom Tabs）からアプリへ戻す一度きりのコード。
  // 始めたアプリの code_verifier（PKCE S256）と合う時だけ使える。利用者が手で入れる場所は無い。

  createAppCode(userId: string, codeChallenge: string): string {
    const code = secret("kll");
    const expires = new Date(Date.now() + LOGIN_LINK_MINUTES * 60_000).toISOString();
    run(this.db, "insert into login_links (code_hash, user_id, label, created_at, expires_at, code_challenge) values (?, ?, 'apple-web', ?, ?, ?)", hash(code), userId, now(), expires, codeChallenge);
    return code;
  }

  redeemAppCode(code: string, codeVerifier: string): { session: string; expires_at: string } {
    return tx(this.db, () => {
      const row = get<{ user_id: string; expires_at: string; used_at: string | null; code_challenge: string | null }>(this.db, "select user_id, expires_at, used_at, code_challenge from login_links where code_hash = ?", hash(code));
      const invalid = new ApiError("unauthorized", "ログインの手続きの期限が切れました。最初からやり直してください。");
      if (!row || row.used_at || row.expires_at < now() || !row.code_challenge) throw invalid;
      if (createHash("sha256").update(codeVerifier).digest("base64url") !== row.code_challenge) throw invalid;
      run(this.db, "update login_links set used_at = ? where code_hash = ?", now(), hash(code));
      return this.issueSession(row.user_id, "apple");
    });
  }

  // ---- ブラウザで始めるAppleとGoogleのログイン（AndroidのCustom Tabs・デスクトップのシステムのブラウザ）。state と nonce と、アプリの code_challenge と戻り先を覚えておく ----

  /** redirectUri は検証済みのループバックURL（無ければアプリのscheme）。戻り先はここに保存した値だけで決める。 */
  startAuthFlow(provider: "apple" | "google", codeChallenge: string, redirectUri?: string) {
    const state = secret("kst");
    const nonce = secret("kno");
    const expires = new Date(Date.now() + LOGIN_LINK_MINUTES * 60_000).toISOString();
    run(this.db, "insert into auth_flows (state, provider, nonce, code_challenge, created_at, expires_at, redirect_uri) values (?, ?, ?, ?, ?, ?, ?)",
      state, provider, nonce, codeChallenge, now(), expires, redirectUri ?? null);
    run(this.db, "delete from auth_flows where expires_at < ?", new Date(Date.now() - 86400_000).toISOString());
    return { state, nonce, expires_at: expires };
  }

  /** flowを使い切りにして返す。別の提供元のflowは、使い切りにせず断る（他の提供元のcallbackで消せない）。 */
  takeAuthFlow(state: string, provider: "apple" | "google") {
    return tx(this.db, () => {
      const row = get<{ provider: string; nonce: string; code_challenge: string; expires_at: string; used_at: string | null }>(this.db, "select * from auth_flows where state = ?", state);
      if (!row || row.used_at || row.expires_at < now() || row.provider !== provider) throw new ApiError("unauthorized", "ログインの手続きの期限が切れました。最初からやり直してください。");
      run(this.db, "update auth_flows set used_at = ? where state = ?", now(), state);
      return row;
    });
  }

  /**
   * 戻り先のループバックURLを、flowを消費せずに引く。期限内の、同じ提供元のflowだけ。
   * 使い切り後も引ける（取り消しや失敗を、同じ戻り先へ返すため）。無ければ null（アプリのschemeへ戻す）。
   */
  authFlowRedirect(state: string, provider: "apple" | "google"): string | null {
    const row = get<{ provider: string; expires_at: string; redirect_uri: string | null }>(this.db, "select provider, expires_at, redirect_uri from auth_flows where state = ?", state);
    return row && row.provider === provider && row.expires_at >= now() ? row.redirect_uri : null;
  }

  bindAuthFlow(state: string, userId: string) {
    run(this.db, "update auth_flows set link_user_id=? where state=?", userId, state);
  }

  /**
   * AppleかGoogleで入る。そのIDのアカウントがあればそこへ、無ければ作る。
   * 同じIDならどの画面から入っても同じアカウント。違うIDなら別のアカウント（結ぶ・まとめる操作は無い。クオの裁定）。
   */
  signInWithIdentity(provider: "apple" | "google", subject: string) {
    return tx(this.db, () => {
      const linked = get<{ user_id: string }>(this.db, "select user_id from identities where provider = ? and subject = ?", provider, subject);
      const userId = linked?.user_id ?? this.createUser();
      if (!linked) run(this.db, "insert into identities (provider, subject, user_id, created_at) values (?, ?, ?, ?)", provider, subject, userId, now());
      return { ...this.issueSession(userId, provider), user: { id: userId } };
    });
  }

  revokeSession(session: string) {
    run(this.db, "delete from sessions where token_hash = ?", hash(session));
  }

  deleteUser(userId: string) {
    run(this.db, "delete from users where id = ?", userId);
  }

  /** entitlements は共有ライブラリの通行証で来た時だけ（契約はそこから決める）。 */
  me(userId: string, entitlements?: { productId: string; store: string; expiresAt?: string }[]) {
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
    const live = entitlements?.find((e) => e.productId === PRODUCT_ID);
    // 通行証の契約は exempt（課金の対象外）なら期限もストアも出さない。
    const free = entitlements ? live?.store === "exempt" : this.billing === "off" || this.freeAccountIds.has(userId);
    const plan = entitlements ? (live ? "active" : "expired") : free ? "active" : effectivePlan(user);
    const store = entitlements ? ({ apple: "app_store", google: "google_play" } as Record<string, string>)[live?.store ?? ""] : user.store;
    const expiresAt = entitlements ? live?.expiresAt : user.plan_expires_at;
    if (plan === "expired" && !entitlements) this.onExpired?.(userId);
    const login = get<{ provider: string }>(this.db, "select provider from identities where user_id = ? order by created_at", userId);
    return {
      user_id: user.id,
      login: login?.provider ?? null,
      setup: { verified: !!user.setup_verified_at, ...(user.setup_verified_at ? { verified_at: user.setup_verified_at } : {}), checks },
      plan,
      ...(expiresAt && !free ? { expires_at: expiresAt } : {}),
      ...(store && !free ? { store } : {}),
      billing: this.billing,
      ...(entitlements ? { purchase_mark: userId } : {}), // 購入に付ける印。Kそのもの（ライブラリの契約）
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

  /** 共有ライブラリが「契約なし」と覚えているアカウントは402（G2）。覚えが無い（unknown）時は何もしない。 */
  assertContract(userId: string) {
    if (this.contract?.(userId) === "none") throw new ApiError("subscription_expired", "Approval Boxの契約がありません。iPhone・Mac・Android のアプリで契約してください。");
  }

  assertCanUse(userId: string) {
    if (this.billing === "off" || this.freeAccountIds.has(userId)) return;
    if (this.contract?.(userId) === "active") return;
    this.assertContract(userId);
    const user = get<UserRow>(this.db, "select * from users where id = ?", userId)!;
    if (effectivePlan(user) !== "active") {
      this.onExpired?.(userId);
      throw new ApiError("subscription_expired", "Approval Boxの契約がありません。iPhone・Mac・Android のアプリで契約してください。");
    }
  }

  /** ストアで照合した契約を反映する。 */
  setPlan(userId: string, plan: "active" | "expired", expiresAt: string | null, store: "app_store" | "google_play") {
    run(this.db, "update users set plan = ?, plan_expires_at = ?, store = ? where id = ?", plan, expiresAt, store, userId);
  }

  /**
   * 契約は1アカウントに1つ。users.plan・plan_expires_at・store は、App Store・Google Playの記録から毎回導く（手で書かない）。
   * 払い済みの期間が残るものがあれば、期限が最も遅いものが決める。無ければ、最後の期間のものを expired で残す。
   * 記録がまだ無いアカウント（無料体験）は触らない。
   */
  syncPlan(userId: string) {
    const nowIso = now();
    type Candidate = { store: "app_store" | "google_play"; end: string | null; paid: boolean };
    const candidates: Candidate[] = [
      ...all<{ expires_at: string | null; revoked: number }>(this.db, "select expires_at, revoked from appstore_subscriptions where user_id = ?", userId)
        .map((r): Candidate => ({ store: "app_store", end: r.expires_at, paid: !r.revoked && !!r.expires_at && r.expires_at > nowIso })),
      ...all<{ state: string; expires_at: string | null }>(this.db, "select state, expires_at from play_subscriptions where user_id = ?", userId)
        .map((r): Candidate => ({ store: "google_play", end: r.expires_at, paid: PLAY_PAID_STATES.has(r.state) && !!r.expires_at && r.expires_at > nowIso })),
    ];
    if (!candidates.length) return;
    const latest = (list: Candidate[]) => list.reduce((a, b) => ((b.end ?? "") > (a.end ?? "") ? b : a));
    const paid = candidates.filter((c) => c.paid);
    const chosen = latest(paid.length ? paid : candidates);
    this.setPlan(userId, paid.length ? "active" : "expired", chosen.end, chosen.store);
  }

  assertSetupVerified(userId: string) {
    const user = get<UserRow>(this.db, "select * from users where id = ?", userId)!;
    if (!user.setup_verified_at) throw new ApiError("setup_not_verified", "セットアップ確認がまだです。AIに「Approval Boxのsetup_testを実行して」と言って、答えがAIまで届くことを確かめてから契約してください。");
  }

  // ---- 接続（端末・リモート）----

  connections(userId: string) {
    type Conn = { id: string; kind: string; label: string; os?: string; clients: string[]; created_at: string; last_seen_at?: string };
    const devices: Conn[] = all<ConnectionRow>(this.db, "select * from connections where user_id = ? and revoked_at is null order by created_at", userId).map((c) => ({
      id: c.id, kind: c.kind === "token" ? "device" : c.kind, label: c.label, ...(c.os ? { os: c.os } : {}), clients: JSON.parse(c.clients) as string[],
      created_at: c.created_at, ...(c.last_seen_at ? { last_seen_at: c.last_seen_at } : {}),
    }));
    // 承認済みの登録クライアント（BellTeamなど）。外す（DELETE /connections/{id}）と、そのsessionは即座に使えなくなる。
    const clients = all<{ id: string; label: string | null; created_at: string; client: string }>(this.db, "select id, label, created_at, client from sessions where user_id = ? and client is not null and id is not null and expires_at >= ? order by created_at", userId, now())
      .map((s): Conn => ({ id: s.id, kind: "client", label: CLIENTS[s.client] ?? s.client, clients: [], created_at: s.created_at }));
    return [...devices, ...clients] satisfies Conn[];
  }

  createConnection(userId: string, label: string, os: string | null, clients: string[], kind: "device" | "token" = "device") {
    const id = uuid();
    const token = secret("kbt");
    run(this.db, "insert into connections (id, user_id, kind, label, os, clients, token_hash, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id, userId, kind, label, os, JSON.stringify(clients), hash(token), now());
    return { id, token };
  }

  // ---- 通知を受ける端末（アプリ・Web Push）。同じ宛先（tokenやsubscription）は同じidに上書きする ----

  registerDevice(userId: string, input: { platform: "ios" | "android" | "web"; locale?: Locale; apns_token?: string; apns_env?: "sandbox" | "production"; fcm_token?: string; web_push_subscription?: unknown }) {
    const subscription = input.web_push_subscription === undefined ? null : JSON.stringify(input.web_push_subscription);
    const key = input.platform === "ios" ? input.apns_token : input.platform === "android" ? input.fcm_token : subscription;
    if (!key) throw new ApiError("validation_failed", input.platform === "ios" ? "apns_token が要ります。" : input.platform === "android" ? "fcm_token が要ります。" : "web_push_subscription が要ります。");
    const pushKey = `${input.platform}:${hash(key)}`;
    const existing = get<{ id: string; locale: Locale }>(this.db, "select id, locale from devices where user_id = ? and push_key = ?", userId, pushKey);
    const id = existing?.id ?? uuid();
    run(this.db, `insert into devices (id, user_id, platform, push_key, apns_token, apns_env, fcm_token, web_push_subscription, created_at, updated_at, locale)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, push_key) do update set apns_env = excluded.apns_env, updated_at = excluded.updated_at, locale = excluded.locale`,
      id, userId, input.platform, pushKey, input.apns_token ?? null, input.apns_env ?? null, input.fcm_token ?? null, subscription, now(), now(), input.locale ?? existing?.locale ?? "ja");
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
    if (!result.changes) {
      if (run(this.db, "delete from sessions where id = ? and user_id = ? and client is not null", id, userId).changes) return;
      throw new ApiError("not_found", "その接続は見つかりません。");
    }
    run(this.db, "delete from setup_checks where connection_id = ?", id);
    run(this.db, "delete from request_uploads where connection_id = ?", id);
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

  startPairing(deviceName: string, os: string | null, clients: string[], publicUrl: string, client?: string) {
    if (client !== undefined && !CLIENTS[client]) throw new ApiError("validation_failed", "その接続先は登録されていません。");
    const id = uuid();
    const pollSecret = secret("kps");
    let code = pairingCode();
    while (get(this.db, "select 1 from pairings where code = ?", code)) code = pairingCode();
    const expires = new Date(Date.now() + (client ? CLIENT_PAIRING_MINUTES * 60_000 : PAIRING_DAYS * 86400_000)).toISOString();
    run(this.db, "insert into pairings (id, code, poll_secret_hash, device_name, os, clients, status, created_at, expires_at, client) values (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)",
      id, code, hash(pollSecret), deviceName, os, JSON.stringify(clients), now(), expires, client ?? null);
    return { pairing_id: id, code, qr_url: `${publicUrl}/pair?c=${code}`, poll_secret: pollSecret, expires_at: expires };
  }

  lookupPairing(codeInput: string) {
    const code = normalizePairingCode(codeInput);
    if (!code) throw new ApiError("validation_failed", "コードは英字と数字の8文字です。");
    const row = get<PairingRow>(this.db, "select * from pairings where code = ?", code);
    if (!row || row.status !== "waiting" || row.expires_at < now()) throw new ApiError("not_found", "そのコードは見つからないか、期限が切れています。PCで npx -y approval-box@latest setup をやり直してください。");
    return {
      pairing_id: row.id, device_name: row.device_name, ...(row.os ? { os: row.os } : {}), clients: JSON.parse(row.clients) as string[], expires_at: row.expires_at,
      // 登録クライアントの接続。承認すると、そのクライアントに読み書きの一部を許す（claimに confirm_client が要る）。
      ...(row.client ? { client: row.client, client_name: CLIENTS[row.client] ?? row.client } : {}),
    };
  }

  claimPairing(userId: string, id: string, confirmClient?: string) {
    return tx(this.db, () => {
      const row = get<PairingRow>(this.db, "select * from pairings where id = ?", id);
      if (!row || row.status !== "waiting" || row.expires_at < now()) throw new ApiError("not_found", "このペアリングは期限が切れています。PCで npx -y approval-box@latest setup をやり直してください。");
      if (row.client) {
        // 範囲付きsessionを渡す承認。許す相手を画面に出せる版のアプリだけが、confirm_client を付けて承認できる。
        if (confirmClient !== row.client) throw new ApiError("conflict", "この接続は、許す内容を表示できる新しい版の画面から承認してください。");
        const issued = this.issueSession(userId, row.client, row.client);
        run(this.db, "update pairings set status = 'claimed', user_id = ?, token = ? where id = ?", userId, issued.session, id);
        this.events.publish(userId, "setup.updated", {});
        return { client: row.client };
      }
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
      if (row.client) {
        const issued = get<{ expires_at: string }>(this.db, "select expires_at from sessions where token_hash = ?", hash(row.token));
        return { status: "claimed" as const, client: row.client, session: row.token, expires_at: issued?.expires_at ?? null };
      }
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
