// 共有の login-billing ライブラリ（kitepon/login-billing 0.17.0、無改造）をApproval Boxへつなぐ所。形は docs/architecture/login-pass.md。
// ライブラリの内側は読まない。公開の入口（createLoginBilling・createHandler・Storage）だけを使う。
import { createHandler, createLoginBilling, type AppleStoreConfig, type GoogleStoreConfig, type LoginBilling, type Storage, type WebSignInConfig } from "@kitepon/login-billing/server";
import { type Db, get, run } from "./db.ts";

/** 月額の商品（App Store・Google Playで同じID）。 */
export const PRODUCT_ID = "dev.kitepon.approvalbox.monthly";

/** ライブラリの Storage を、SQLiteの lb_kv に置く。入れるのは nonce・QRの枠・止めた通行証の印・「すべて止める」の時刻だけ（期限つき）。 */
export class SqliteStorage implements Storage {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  async get(key: string) {
    return get<{ value: string }>(this.db, "select value from lb_kv where key = ? and expires_at > ?", key, this.now())?.value;
  }

  async put(key: string, value: string, ttlMs: number) {
    run(this.db, "insert into lb_kv (key, value, expires_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, expires_at = excluded.expires_at", key, value, this.now() + ttlMs);
  }

  async delete(key: string) {
    run(this.db, "delete from lb_kv where key = ?", key);
  }

  /** 一度きりの記録を、読むと同時に消す（契約1.20）。1つの文なので、同時に2つ来ても受け取れるのは片方だけ。 */
  async take(key: string) {
    const row = get<{ value: string; expires_at: number }>(this.db, "delete from lb_kv where key = ? returning value, expires_at", key);
    return row && row.expires_at > this.now() ? row.value : undefined;
  }

  private readonly hits = new Map<string, { n: number; until: number }>();

  /** 接続元ごとの回数（契約1.21）。鍵はライブラリがHMACした値。メモリだけで数え、ディスクへは書かない。 */
  async hit(key: string, limit: number, windowMs: number) {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.until <= t) {
      if (this.hits.size >= 100_000) for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k);
      this.hits.set(key, { n: 1, until: t + windowMs });
      return 1 <= limit;
    }
    return ++h.n <= limit;
  }

  /** 期限を過ぎた行を消す（読む側も期限切れは見ない）。 */
  sweep() {
    run(this.db, "delete from lb_kv where expires_at <= ?", this.now());
  }
}

/** 接続元ごとの回数制限。メモリだけで持ち、接続元は保存もログにも出さない。 */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { n: number; until: number }>();
  let nextSweep = 0;
  return (client: string) => {
    const t = now();
    if (t >= nextSweep) {
      nextSweep = t + windowMs;
      for (const [key, hit] of hits) if (hit.until <= t) hits.delete(key);
    }
    const hit = hits.get(client);
    if (!hit || hit.until <= t) { hits.set(client, { n: 1, until: t + windowMs }); return true; }
    return ++hit.n <= limit;
  };
}

export type LibraryInput = {
  db: Db;
  publicUrl: string;
  billing: "off" | "store";
  /** LB_K_KEY（base64url、32バイト以上）。 */
  kKey: string;
  /** LB_PASS_KEY とその名前。LB_PASS_KEY_PREVIOUS は鍵を替える間だけ。 */
  passKey: { id: string; key: string };
  passKeyPrevious?: { id: string; key: string };
  appleAudiences: string[];
  googleAudiences: string[];
  /** Google の id だけで入る道（試験。LB_GOOGLE_CODE_CLIENT_ID・LB_GOOGLE_CODE_CLIENT_SECRET が揃った時だけ）。 */
  googleCode?: { clientId: string; clientSecret: string };
  /** Web サインイン（契約1.20）。戻り先は publicUrl から作る（loopback・セッションのスキーム・/app/websignin のリンク）。 */
  webSignIn?: Pick<WebSignInConfig, "google" | "apple">;
  apple?: AppleStoreConfig;
  google?: GoogleStoreConfig;
  /** 課金の対象外にする K（FREE_ACCOUNT_IDS）。 */
  exemptK: string[];
  fetch?: typeof fetch;
  now?: () => number;
};

/** ライブラリ本体と、/auth/v1 に置く受け口。鍵が足りない・形が違う時は createLoginBilling が投げる（値は含まない）。 */
export function createLibrary(input: LibraryInput) {
  const storage = new SqliteStorage(input.db, input.now);
  const lb: LoginBilling = createLoginBilling({
    signIn: { apple: input.appleAudiences, google: input.googleAudiences, ...(input.googleCode ? { googleCode: input.googleCode } : {}) },
    stores: { ...(input.apple ? { apple: input.apple } : {}), ...(input.google ? { google: input.google } : {}) },
    products: [{ productId: PRODUCT_ID, store: "apple", kind: "subscription" }, { productId: PRODUCT_ID, store: "google", kind: "subscription" }],
    kKey: input.kKey,
    passKeys: { current: input.passKey, ...(input.passKeyPrevious ? { previous: input.passKeyPrevious } : {}) },
    exemptK: input.exemptK,
    ...(input.webSignIn && (input.webSignIn.google || input.webSignIn.apple) ? { webSignIn: { ...input.webSignIn, publicOrigin: input.publicUrl, returns: { loopback: true, sessionSchemes: ["approvalbox-websignin"], links: [`${input.publicUrl}/app/websignin`] } } } : {}),
    billing: input.billing,
    storage,
    // ライブラリが出す1種類の行（Webサインインの失敗の理由。固定の一覧の符号だけで、K・利用者の識別子・トークン・アドレスは載らない）を、サーバーのいつもの1行のログへ。
    log: (line: string) => console.error(`approval-box-server: ${line}`),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  // 接続元は手前のプロキシ（Caddy・cloudflared）が付けた X-Forwarded-For の最後の値。http.ts の clientKey と同じ。
  const handler = createHandler(lb, { prefix: "/auth/v1", origins: [input.publicUrl], caller: (r) => r.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined });
  // signin/nonce・handoff/start・websignin/start・prove/take・ticket/check はライブラリが接続元ごとに絞る（0.10.1。handoff/start は 0.17.0 から署名つきの開始も通行証ごとに絞る）。残る名前のない2つをここで絞る。
  const limits: Record<string, (client: string) => boolean> = { "/auth/v1/websignin/callback": rateLimiter(20, 60_000), "/auth/v1/websignin/take": rateLimiter(60, 60_000) };
  return { lb, handler, storage, allow: (path: string, client: string) => limits[path]?.(client) ?? true };
}
export type Library = ReturnType<typeof createLibrary>;
