// Stripeの購入（Web・Windows・Linuxの利用者向け）。形は docs/billing-stripe.md。
// 依存を足さず、Stripe APIはfetch、署名の確かめはnode:cryptoで行う。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Accounts } from "./accounts.ts";
import { type Db, all, get, run } from "./db.ts";
import { ApiError } from "./errors.ts";
import { now } from "./ids.ts";

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  /** 解約画面の設定（bpc_…）。同じStripeアカウントの別製品の既定の画面と分けるため、決裁箱専用を指す。無ければ既定。 */
  portalConfiguration?: string;
  /** 決済・ポータルから戻る先（公式サーバーのURL）。 */
  publicUrl: string;
  fetch?: typeof fetch;
};

const API = "https://api.stripe.com/v1";
/** Stripe推奨の許容。これより古い署名は、盗まれた通知の使い回しとして断る。 */
const TOLERANCE_SECONDS = 300;
const HANDLED = new Set(["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

type StripeSubscription = {
  id: string; customer: string; status: string; cancel_at_period_end?: boolean;
  current_period_end?: number; items?: { data?: { current_period_end?: number }[] };
  metadata?: Record<string, string>;
};

/** 契約の期末。APIの版によって、契約か明細（items）のどちらかにある。 */
const periodEnd = (s: StripeSubscription) => s.current_period_end ?? s.items?.data?.[0]?.current_period_end;

export class Stripe {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly config: StripeConfig;

  constructor(db: Db, accounts: Accounts, config: StripeConfig) {
    this.db = db;
    this.accounts = accounts;
    this.config = config;
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await (this.config.fetch ?? fetch)(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError("internal", "決済サービス（Stripe）につながりません。時間を置いて試してください。");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Stripeの本文（カードや住所を含みうる）は返さず、種別だけ記録する。
      console.error(`approval-box-server: Stripe ${method} ${path.split("?")[0]} -> ${res.status} ${(json.error as { type?: string; code?: string } | undefined)?.type ?? ""} ${(json.error as { code?: string } | undefined)?.code ?? ""}`);
      throw new ApiError("internal", "決済サービス（Stripe）が受け付けませんでした。時間を置いて試してください。");
    }
    return json;
  }

  /** 払い済みの期間が残る契約を持つか。二重に払わせない。 */
  private hasPaidPeriod(userId: string) {
    this.accounts.syncPlan(userId);
    const me = this.accounts.me(userId);
    return me.plan === "active" && !!me.store;
  }

  /** POST /v1/billing/stripe/checkout。Stripeの支払い画面のURLを返す。 */
  async checkout(userId: string) {
    this.accounts.assertSetupVerified(userId);
    if (this.hasPaidPeriod(userId)) throw new ApiError("conflict", "すでに契約中です。契約の変更・解約は、契約している窓口で行ってください。");
    const customer = get<{ customer_id: string }>(this.db, "select customer_id from stripe_subscriptions where user_id = ? order by updated_at desc", userId)?.customer_id;
    const session = await this.call("POST", "/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": this.config.priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: userId,
      "subscription_data[metadata][user_id]": userId,
      "automatic_tax[enabled]": "true",
      ...(customer ? { customer, "customer_update[address]": "auto" } : { billing_address_collection: "auto" }),
      success_url: `${this.config.publicUrl}/settings?billing=success`,
      cancel_url: `${this.config.publicUrl}/settings`,
    });
    if (typeof session.url !== "string") throw new ApiError("internal", "決済サービス（Stripe）の応答が正しくありません。");
    return { url: session.url };
  }

  /** POST /v1/billing/stripe/portal。解約・カード変更・領収書のページ。 */
  async portal(userId: string) {
    const customer = get<{ customer_id: string }>(this.db, "select customer_id from stripe_subscriptions where user_id = ? order by updated_at desc", userId)?.customer_id;
    if (!customer) throw new ApiError("not_found", "Stripeでの契約がありません。");
    const session = await this.call("POST", "/billing_portal/sessions", { customer, return_url: `${this.config.publicUrl}/settings`, ...(this.config.portalConfiguration ? { configuration: this.config.portalConfiguration } : {}) });
    if (typeof session.url !== "string") throw new ApiError("internal", "決済サービス（Stripe）の応答が正しくありません。");
    return { url: session.url };
  }

  /** アカウント削除の前に、Stripeの契約を止める。止められなければ消さない（消えたアカウントへ請求し続けない）。 */
  async cancelAll(userId: string) {
    const live = all<{ subscription_id: string }>(this.db, "select subscription_id from stripe_subscriptions where user_id = ? and status not in ('canceled', 'incomplete_expired')", userId);
    for (const { subscription_id } of live) {
      try { await this.call("DELETE", `/subscriptions/${encodeURIComponent(subscription_id)}`); }
      catch (error) {
        // 既に止まっているなら続ける。読み直せない・止まっていないなら、削除を止める。
        const now = await this.read(subscription_id).catch(() => undefined);
        if (!now || !["canceled", "incomplete_expired"].includes(now.status)) throw error;
      }
    }
  }

  private async read(subscriptionId: string) {
    return (await this.call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`)) as unknown as StripeSubscription;
  }

  /** `Stripe-Signature: t=…,v1=…` を、署名の鍵と本文のバイト列で確かめる。 */
  verifySignature(raw: string, header: string | undefined) {
    const parts = (header ?? "").split(",").map((p) => p.trim().split("=") as [string, string]);
    const t = parts.find(([k]) => k === "t")?.[1];
    const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
    const bad = () => new ApiError("validation_failed", "Stripeの署名を確かめられませんでした。");
    if (!t || !sigs.length || !/^\d+$/.test(t)) throw bad();
    if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) throw bad();
    const expected = createHmac("sha256", this.config.webhookSecret).update(`${t}.${raw}`).digest();
    const ok = sigs.some((s) => { const got = Buffer.from(s, "hex"); return got.length === expected.length && timingSafeEqual(got, expected); });
    if (!ok) throw bad();
  }

  /** POST /v1/stripe/webhook。通知は合図で、契約の中身はStripeから読み直す（順不同・二重に届いても期末を巻き戻さない）。 */
  async webhook(raw: string, signature: string | undefined) {
    this.verifySignature(raw, signature);
    let event: { type?: string; data?: { object?: Record<string, unknown> } };
    try { event = JSON.parse(raw); } catch { throw new ApiError("validation_failed", "Stripeの通知の形が正しくありません。"); }
    const object = event.data?.object ?? {};
    if (!event.type || !HANDLED.has(event.type)) return { applied: false };
    const subscriptionId = event.type === "checkout.session.completed" ? object.subscription : object.id;
    if (typeof subscriptionId !== "string") return { applied: false };
    const subscription = await this.read(subscriptionId);
    const claimed = event.type === "checkout.session.completed" ? object.client_reference_id : subscription.metadata?.user_id;
    const known = get<{ user_id: string }>(this.db, "select user_id from stripe_subscriptions where subscription_id = ?", subscriptionId)?.user_id;
    const userId = known ?? (typeof claimed === "string" ? claimed : subscription.metadata?.user_id);
    // 自分が決済へ送った利用者の印と、Stripeの契約に付けた印が食い違うものは、どちらも信じない。
    if (!userId || (subscription.metadata?.user_id && subscription.metadata.user_id !== userId)) return { applied: false };
    if (!get(this.db, "select id from users where id = ?", userId)) return { applied: false };
    const end = periodEnd(subscription);
    run(this.db, `insert into stripe_subscriptions (subscription_id, user_id, customer_id, status, current_period_end, cancel_at_period_end, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict (subscription_id) do update set customer_id = excluded.customer_id, status = excluded.status,
          current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
      subscriptionId, userId, String(subscription.customer), subscription.status, end ? new Date(end * 1000).toISOString() : null, subscription.cancel_at_period_end ? 1 : 0, now());
    this.accounts.syncPlan(userId);
    return { applied: true };
  }
}
