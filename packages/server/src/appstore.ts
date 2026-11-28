// App Storeの購入（StoreKit 2）の照合。形は api.md の「契約」。
// 署名付きの取引（JWS）は、Appleのルート証明書までの署名を確かめてから使う。アプリが申告した値は使わない。
import { Environment, SignedDataVerifier, type JWSRenewalInfoDecodedPayload, type JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import type { Signer } from "./auth-module.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Accounts } from "./accounts.ts";
import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import { now } from "./ids.ts";

export type AppStoreConfig = {
  bundleId: string;
  /** 本番の取引の検証に要る、アプリのApple ID（数字）。無ければ本番の購入は受け付けない。 */
  appAppleId?: number;
  /** 受け付ける自動更新サブスクの商品ID。 */
  productIds: string[];
  rootCertificates: Buffer[];
  /** 証明書の失効をAppleへ問い合わせる（OCSP）。試験の証明書では切る。 */
  onlineChecks?: boolean;
  /** App Store Server API（契約の状態をAppleから読む鍵）。無ければ、署名付きの取引の値で決める（従来どおり）。 */
  api?: { issuerId: string; keyId: string; sign: Signer; fetch?: typeof fetch };
};

/** 期限切れを見て読み直す間隔の下限（同じ購入につき）。 */
const REREAD_INTERVAL_MS = 10 * 60_000;

/** Appleの契約の状態（Status）を、払い済みの期限と取り消しへ直す。表は docs/billing.md。 */
function paidState(status: number | undefined, transaction: JWSTransactionDecodedPayload, renewal: JWSRenewalInfoDecodedPayload | undefined) {
  const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);
  const end = iso(transaction.expiresDate);
  if (status === 5 || transaction.revocationDate) return { expires: end, revoked: true };
  if (status === 1) return { expires: end, revoked: false };
  if (status === 4) return { expires: iso(renewal?.gracePeriodExpiresDate) ?? end, revoked: false }; // 課金の猶予期間は払い済み
  const t = now(); // 2・3・知らない値は未払い。期限が先でも払い済みにしない
  return { expires: end && end < t ? end : t, revoked: false };
}

/** 同梱したAppleのルート証明書（packages/server/certs、https://www.apple.com/certificateauthority/）。 */
export function appleRootCertificates(dir: string): Buffer[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".cer")).map((f) => readFileSync(join(dir, f)));
}

/** 署名を確かめる前に、どの環境の検証器で確かめるかだけを読む。ここで読んだ値で判断はしない。 */
function peekPayload(jws: string): Record<string, unknown> {
  const part = jws.split(".")[1];
  if (!part) throw new ApiError("validation_failed", "購入の情報（jws）の形が正しくありません。");
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { throw new ApiError("validation_failed", "購入の情報（jws）の形が正しくありません。"); }
}

const ACCEPTED = [Environment.SANDBOX, Environment.PRODUCTION] as const;
type Accepted = (typeof ACCEPTED)[number];

function asEnvironment(value: unknown): Accepted {
  const env = ACCEPTED.find((e) => e === value);
  if (!env) throw new ApiError("validation_failed", "この環境の購入は受け付けていません（App StoreのSandboxと本番だけ）。");
  return env;
}

export class AppStore {
  private readonly verifiers = new Map<Accepted, SignedDataVerifier>();

  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly config: AppStoreConfig;

  constructor(db: Db, accounts: Accounts, config: AppStoreConfig) {
    this.db = db;
    this.accounts = accounts;
    this.config = config;
    // 期限が切れたアカウントを Accounts が見たら、更新の通知の取りこぼしを疑ってAppleから読み直す。
    accounts.onExpired = (userId) => this.refreshExpired(userId);
  }

  private verifier(env: Accepted): SignedDataVerifier {
    const cached = this.verifiers.get(env);
    if (cached) return cached;
    if (!this.config.rootCertificates.length) throw new ApiError("internal", "Appleのルート証明書がありません。");
    if (env === Environment.PRODUCTION && !this.config.appAppleId) throw new ApiError("internal", "本番の購入を確かめる設定（アプリのApple ID）がまだありません。");
    const verifier = new SignedDataVerifier(this.config.rootCertificates, this.config.onlineChecks ?? true, env, this.config.bundleId, this.config.appAppleId);
    this.verifiers.set(env, verifier);
    return verifier;
  }

  private async decodeTransaction(env: Accepted, jws: string): Promise<JWSTransactionDecodedPayload> {
    try { return await this.verifier(env).verifyAndDecodeTransaction(jws); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("validation_failed", "購入の署名を確かめられませんでした。");
    }
  }

  /** POST /v1/billing/appstore/verify。購入直後にアプリが送る署名付きの取引。 */
  async verifyPurchase(userId: string, jws: string) {
    const env = asEnvironment(peekPayload(jws).environment);
    // お金の動く本物の購入だけ、セットアップ確認を求める（審査とTestFlightのSandboxは通す。クオの裁定 2026-10-01）。
    if (env === Environment.PRODUCTION) this.accounts.assertSetupVerified(userId);
    const transaction = await this.decodeTransaction(env, jws);
    this.assertAcceptable(userId, transaction);
    if (this.config.api) {
      if (!transaction.originalTransactionId) throw new ApiError("validation_failed", "購入の情報に元の取引IDがありません。");
      // アプリが送った取引は合図。状態はAppleから読む。
      if (!(await this.reread(userId, env, transaction.originalTransactionId))) throw new ApiError("validation_failed", "Appleがこの購入を知りません。");
    } else this.apply(userId, env, transaction);
    return this.accounts.me(userId);
  }

  private assertAcceptable(userId: string, transaction: JWSTransactionDecodedPayload) {
    if (!transaction.productId || !this.config.productIds.includes(transaction.productId)) throw new ApiError("validation_failed", "この商品は受け付けていません。");
    if (transaction.appAccountToken && transaction.appAccountToken.toLowerCase() !== userId) throw new ApiError("conflict", "この購入は別のアカウントのものです。");
  }

  /** App Store Server API の Get All Subscription Statuses。Appleが知らない購入は undefined。 */
  private async fetchState(env: Accepted, original: string) {
    const api = this.config.api!;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: api.keyId, typ: "JWT" })).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ iss: api.issuerId, iat, exp: iat + 300, aud: "appstoreconnect-v1", bid: this.config.bundleId })).toString("base64url");
    let signature: string;
    try { signature = (await api.sign(Buffer.from(`${header}.${claims}`))).toString("base64url"); } catch (error) {
      console.error(`approval-box-server: App Store Server API sign -> ${(error as Error).message}`);
      throw new ApiError("internal", "Appleから契約の状態を読めませんでした。");
    }
    const host = env === Environment.PRODUCTION ? "https://api.storekit.itunes.apple.com" : "https://api.storekit-sandbox.itunes.apple.com";
    let res: Response;
    try {
      res = await (api.fetch ?? fetch)(`${host}/inApps/v1/subscriptions/${encodeURIComponent(original)}`, { headers: { authorization: `Bearer ${header}.${claims}.${signature}` }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new ApiError("internal", "Appleから契約の状態を読めませんでした。"); }
    if (res.status === 404) return undefined;
    if (!res.ok) {
      console.error(`approval-box-server: App Store Server API -> ${res.status}`);
      throw new ApiError("internal", "Appleから契約の状態を読めませんでした。");
    }
    const body = await res.json().catch(() => ({})) as { data?: { lastTransactions?: { status?: number; originalTransactionId?: string; signedTransactionInfo?: string; signedRenewalInfo?: string }[] }[] };
    const item = body.data?.flatMap((group) => group.lastTransactions ?? []).find((t) => t.originalTransactionId === original);
    if (!item?.signedTransactionInfo) return undefined;
    const transaction = await this.decodeTransaction(env, item.signedTransactionInfo);
    let renewal: JWSRenewalInfoDecodedPayload | undefined;
    try { renewal = item.signedRenewalInfo ? await this.verifier(env).verifyAndDecodeRenewalInfo(item.signedRenewalInfo) : undefined; }
    catch { throw new ApiError("validation_failed", "更新の情報の署名を確かめられませんでした。"); }
    return { transaction, state: paidState(item.status, transaction, renewal) };
  }

  /** Appleから契約の状態を読み直して記録する。通知・verify・期限切れの3つの入口が同じ道を通る。Appleが知らなければ false。 */
  private async reread(userId: string, env: Accepted, original: string): Promise<boolean> {
    this.lastRead.set(original, Date.now());
    const found = await this.fetchState(env, original);
    if (!found) return false;
    this.assertAcceptable(userId, found.transaction);
    this.apply(userId, env, found.transaction, found.state);
    return true;
  }

  private readonly lastRead = new Map<string, number>();

  /** Accounts が期限切れを見た時の合図。待たずに裏で読み直し（同じ購入は10分に1回まで）、結果は次の呼び出しから見える。 */
  private refreshExpired(userId: string) {
    if (!this.config.api) return;
    for (const row of all<{ original_transaction_id: string; environment: string }>(this.db, "select original_transaction_id, environment from appstore_subscriptions where user_id = ? and revoked = 0", userId)) {
      const last = this.lastRead.get(row.original_transaction_id);
      if (last !== undefined && Date.now() - last < REREAD_INTERVAL_MS) continue;
      this.reread(userId, row.environment as Accepted, row.original_transaction_id)
        .catch((error) => console.error("approval-box-server: App Storeの契約の読み直しに失敗しました:", error instanceof ApiError ? error.message : "予期しないエラー"));
    }
  }

  /** POST /v1/appstore/notifications（App Store Server Notifications V2）。更新・解約・返金を反映する。 */
  async notification(signedPayload: string) {
    const data = peekPayload(signedPayload).data as Record<string, unknown> | undefined;
    const env = asEnvironment(data?.environment);
    let decoded;
    try { decoded = await this.verifier(env).verifyAndDecodeNotification(signedPayload); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("validation_failed", "通知の署名を確かめられませんでした。");
    }
    const signed = decoded.data?.signedTransactionInfo;
    if (!signed) return { applied: false };
    const transaction = await this.decodeTransaction(env, signed);
    const userId = this.ownerOf(transaction);
    if (!userId) return { applied: false };
    // 通知の本文は合図。持ち主を決めるのに使い、状態はAppleから読み直す。
    if (this.config.api && transaction.originalTransactionId) {
      // 通知は400で返すとAppleが送り直し続ける。受け付けない商品・購入は、Playと同じく適用しないで200にする。
      try { return { applied: await this.reread(userId, env, transaction.originalTransactionId) }; }
      catch (error) { if (error instanceof ApiError && error.code === "validation_failed") return { applied: false }; throw error; }
    }
    this.apply(userId, env, transaction);
    return { applied: true };
  }

  private ownerOf(transaction: JWSTransactionDecodedPayload): string | undefined {
    const linked = transaction.originalTransactionId
      ? get<{ user_id: string }>(this.db, "select user_id from appstore_subscriptions where original_transaction_id = ?", transaction.originalTransactionId)
      : undefined;
    if (linked) return linked.user_id;
    const token = transaction.appAccountToken?.toLowerCase();
    return token && get(this.db, "select id from users where id = ?", token) ? token : undefined;
  }

  /** state はAppleから読んだ最新の状態。あれば古さの比べ合いをせず、そのまま書く。 */
  private apply(userId: string, env: Accepted, transaction: JWSTransactionDecodedPayload, state?: { expires: string | null; revoked: boolean }) {
    const original = transaction.originalTransactionId;
    if (!original) throw new ApiError("validation_failed", "購入の情報に元の取引IDがありません。");
    const expires = state ? state.expires : transaction.expiresDate ? new Date(transaction.expiresDate).toISOString() : null;
    const revoked = state ? state.revoked : !!transaction.revocationDate;
    tx(this.db, () => {
      const linked = get<{ user_id: string; expires_at: string | null }>(this.db, "select user_id, expires_at from appstore_subscriptions where original_transaction_id = ?", original);
      if (linked && linked.user_id !== userId) throw new ApiError("conflict", "この購入は別のアカウントに結ばれています。");
      // 通知は順不同で届く。返金・取り消しでない古い取引で、新しい期限を巻き戻さない。
      if (!state && linked?.expires_at && !transaction.revocationDate && (!expires || expires < linked.expires_at)) return;
      run(this.db, `insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, revoked, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict (original_transaction_id) do update set environment = excluded.environment, product_id = excluded.product_id,
            expires_at = excluded.expires_at, revoked = excluded.revoked, updated_at = excluded.updated_at`,
        original, userId, env, transaction.productId ?? "", expires, revoked ? 1 : 0, now());
      this.accounts.syncPlan(userId);
    });
  }
}
