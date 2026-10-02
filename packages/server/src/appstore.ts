// App Storeの購入（StoreKit 2）の照合。形は api.md の「契約」。
// 署名付きの取引（JWS）は、Appleのルート証明書までの署名を確かめてから使う。アプリが申告した値は使わない。
import { Environment, SignedDataVerifier, type JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Accounts } from "./accounts.ts";
import { type Db, get, run, tx } from "./db.ts";
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
};

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
    if (!transaction.productId || !this.config.productIds.includes(transaction.productId)) throw new ApiError("validation_failed", "この商品は受け付けていません。");
    if (transaction.appAccountToken && transaction.appAccountToken.toLowerCase() !== userId) throw new ApiError("conflict", "この購入は別のアカウントのものです。");
    this.apply(userId, env, transaction);
    return this.accounts.me(userId);
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

  private apply(userId: string, env: Accepted, transaction: JWSTransactionDecodedPayload) {
    const original = transaction.originalTransactionId;
    if (!original) throw new ApiError("validation_failed", "購入の情報に元の取引IDがありません。");
    const expires = transaction.expiresDate ? new Date(transaction.expiresDate).toISOString() : null;
    const active = !transaction.revocationDate && !!expires && expires > now();
    tx(this.db, () => {
      const linked = get<{ user_id: string; expires_at: string | null }>(this.db, "select user_id, expires_at from appstore_subscriptions where original_transaction_id = ?", original);
      if (linked && linked.user_id !== userId) throw new ApiError("conflict", "この購入は別のアカウントに結ばれています。");
      // 通知は順不同で届く。返金・取り消しでない古い取引で、新しい期限を巻き戻さない。
      if (linked?.expires_at && !transaction.revocationDate && (!expires || expires < linked.expires_at)) return;
      run(this.db, `insert into appstore_subscriptions (original_transaction_id, user_id, environment, product_id, expires_at, revoked, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict (original_transaction_id) do update set environment = excluded.environment, product_id = excluded.product_id,
            expires_at = excluded.expires_at, revoked = excluded.revoked, updated_at = excluded.updated_at`,
        original, userId, env, transaction.productId ?? "", expires, transaction.revocationDate ? 1 : 0, now());
      this.accounts.setPlan(userId, active ? "active" : "expired", expires, "app_store");
    });
  }
}
