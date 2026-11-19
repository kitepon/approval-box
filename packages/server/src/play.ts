// Google Playの購入（Androidの利用者向け）。形は docs/billing-play.md。
// 依存を足さず、Google APIはfetch、サービスアカウントの署名はnode:cryptoで行う。
import { sign } from "node:crypto";
import { PLAY_PAID_STATES, type Accounts } from "./accounts.ts";
import { type Db, get, run } from "./db.ts";
import { ApiError } from "./errors.ts";
import { now } from "./ids.ts";
import { type KeySource, verifyIdToken } from "./oidc.ts";

export type PlayConfig = {
  packageName: string;
  /** 売っている定期購読の商品ID。これ以外は断る。 */
  productIds: string[];
  serviceAccount: { client_email: string; private_key: string };
  /** Pub/Subのpush購読に付けたOIDCの audience と、署名するサービスアカウントのメール。 */
  pushAudience: string;
  pushServiceAccount: string;
  fetch?: typeof fetch;
  /** 試験用: Googleの公開鍵の代わり。 */
  keys?: KeySource;
};

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const PENDING = "ACKNOWLEDGEMENT_STATE_PENDING";

type PlaySubscription = {
  subscriptionState?: string;
  lineItems?: { productId?: string; expiryTime?: string }[];
  acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  testPurchase?: Record<string, unknown>;
};

export class Play {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly config: PlayConfig;
  private cached?: { value: string; until: number };

  constructor(db: Db, accounts: Accounts, config: PlayConfig) {
    this.db = db;
    this.accounts = accounts;
    this.config = config;
  }

  private async send(method: "GET" | "POST", url: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    let res: Response;
    try {
      res = await (this.config.fetch ?? fetch)(url, { method, ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ApiError("internal", "決済サービス（Google Play）につながりません。時間を置いて試してください。");
    }
    return { status: res.status, ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** サービスアカウントのJWTをアクセストークンに替える。期限の1分前まで使い回す。 */
  private async accessToken() {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    const iat = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: this.config.serviceAccount.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let assertion: string;
    try {
      assertion = `${input}.${sign("RSA-SHA256", Buffer.from(input), this.config.serviceAccount.private_key).toString("base64url")}`;
    } catch {
      console.error("approval-box-server: Google Play のサービスアカウントの鍵で署名できません");
      throw new ApiError("internal", "決済サービス（Google Play）が受け付けませんでした。時間を置いて試してください。");
    }
    const res = await this.send("POST", TOKEN_URL, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok || typeof res.json.access_token !== "string") {
      console.error(`approval-box-server: Google OAuth token -> ${res.status} ${String(res.json.error ?? "")}`);
      throw new ApiError("internal", "決済サービス（Google Play）が受け付けませんでした。時間を置いて試してください。");
    }
    this.cached = { value: res.json.access_token, until: Date.now() + (Number(res.json.expires_in) || 3600) * 1000 - 60_000 };
    return res.json.access_token;
  }

  /** 購入トークンはURLに入るので、記録には種類（label）と状態だけ残す。 */
  private async call(method: "GET" | "POST", path: string, label: string, body?: string, passthrough: number[] = []) {
    const res = await this.send(method, `${API}/${encodeURIComponent(this.config.packageName)}/${path}`, {
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}),
    });
    if (!res.ok && !passthrough.includes(res.status)) {
      // Googleの本文は返さず、状態だけ記録する。
      console.error(`approval-box-server: Google Play ${label} -> ${res.status} ${String((res.json.error as { status?: string } | undefined)?.status ?? "")}`);
      throw new ApiError("internal", "決済サービス（Google Play）が受け付けませんでした。時間を置いて試してください。");
    }
    return res;
  }

  private async read(purchaseToken: string) {
    const res = await this.call("GET", `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, "subscriptionsv2.get", undefined, [404, 410]);
    if (!res.ok) throw new ApiError("validation_failed", "この購入をGoogle Playで確かめられませんでした。");
    return res.json as PlaySubscription;
  }

  /** 契約の記録を、Googleから読んだ今の状態で書き直す。持ち主（user_id）は最初のまま変えない。 */
  private save(userId: string, purchaseToken: string, productId: string, sub: PlaySubscription) {
    const state = (sub.subscriptionState ?? "").replace(/^SUBSCRIPTION_STATE_/, "") || "UNKNOWN";
    const expiry = Date.parse(sub.lineItems?.find((l) => l.productId === productId)?.expiryTime ?? "");
    const expiresAt = Number.isNaN(expiry) ? null : new Date(expiry).toISOString();
    run(this.db, `insert into play_subscriptions (purchase_token, user_id, product_id, state, expires_at, test, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict (purchase_token) do update set product_id = excluded.product_id, state = excluded.state,
          expires_at = excluded.expires_at, test = excluded.test, updated_at = excluded.updated_at`,
      purchaseToken, userId, productId, state, expiresAt, sub.testPurchase ? 1 : 0, now());
    this.accounts.syncPlan(userId);
    return PLAY_PAID_STATES.has(state) && !!expiresAt && expiresAt > now();
  }

  /** POST /v1/billing/play/verify。アプリが購入直後に送る購入トークンを、Googleから読んで照らす。 */
  async verifyPurchase(userId: string, productId: string, purchaseToken: string) {
    if (!this.config.productIds.includes(productId)) throw new ApiError("validation_failed", "この商品は扱っていません。");
    const sub = await this.read(purchaseToken);
    if (!sub.lineItems?.some((l) => l.productId === productId)) throw new ApiError("validation_failed", "購入の内容が商品と合いません。");
    const bound = get<{ user_id: string }>(this.db, "select user_id from play_subscriptions where purchase_token = ?", purchaseToken)?.user_id;
    // 自分が購入へ付けた利用者の印（obfuscatedAccountId）と、結ばれた持ち主の両方が自分でなければ受け付けない。
    if (sub.externalAccountIdentifiers?.obfuscatedExternalAccountId !== userId || (bound && bound !== userId)) {
      throw new ApiError("conflict", "この購入は、このアカウントのものではありません。");
    }
    // 試験用購入の判断は、アプリの申告でなくGoogleの答え（testPurchase）だけで行う。
    if (!sub.testPurchase) this.accounts.assertSetupVerified(userId);
    const paid = this.save(userId, purchaseToken, productId, sub);
    // 3日以内に承認しないとGoogleが返金する。記録は済んでいるので、失敗は500にしてアプリの再送で繰り返す（承認は冪等）。
    if (paid && sub.acknowledgementState === PENDING) {
      await this.call("POST", `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, "acknowledge", "{}");
    }
    return this.accounts.me(userId);
  }

  /** POST /v1/play/notifications。Pub/Subのpush。通知は合図で、契約の中身はGoogleから読み直す（順不同・二重に届いても巻き戻さない）。 */
  async notification(raw: string, authorization: string | undefined) {
    const bad = () => new ApiError("unauthorized", "Pub/Subの通知を確かめられませんでした。");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) throw bad();
    let id: { email?: string; email_verified?: boolean };
    try {
      id = await verifyIdToken("google", token, { audiences: [this.config.pushAudience], ...(this.config.keys ? { keys: this.config.keys } : {}) });
    } catch (error) {
      if (error instanceof ApiError && error.code !== "unauthorized") throw error;
      throw bad();
    }
    if (id.email !== this.config.pushServiceAccount || id.email_verified !== true) throw bad();
    // 以降は、確かめた送り手の通知。読めない・対象外のものは、再送され続けないよう200で受け流す。
    let event: { packageName?: string; subscriptionNotification?: { purchaseToken?: string } };
    try { event = JSON.parse(Buffer.from(JSON.parse(raw).message.data, "base64").toString("utf8")); } catch { return { applied: false }; }
    const purchaseToken = event.subscriptionNotification?.purchaseToken;
    if (event.packageName !== this.config.packageName || typeof purchaseToken !== "string" || !purchaseToken) return { applied: false };
    let sub: PlaySubscription;
    try { sub = await this.read(purchaseToken); } catch (error) {
      if (error instanceof ApiError && error.code === "validation_failed") return { applied: false };
      throw error;
    }
    const productId = sub.lineItems?.find((l) => l.productId && this.config.productIds.includes(l.productId))?.productId;
    if (!productId) return { applied: false };
    const claimed = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    const bound = get<{ user_id: string }>(this.db, "select user_id from play_subscriptions where purchase_token = ?", purchaseToken)?.user_id;
    // 結ばれた持ち主と、Googleの購入に付いた印が食い違うものは、どちらも信じない。
    if (bound && claimed && claimed !== bound) return { applied: false };
    const userId = bound ?? claimed;
    if (!userId || !get(this.db, "select id from users where id = ?", userId)) return { applied: false };
    this.save(userId, purchaseToken, productId, sub);
    return { applied: true };
  }
}
