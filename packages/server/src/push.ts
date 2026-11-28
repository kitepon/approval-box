import type { Locale } from "./locales.ts";
// アプリへのプッシュ通知（iPhone・Mac＝APNs、Android＝FCM）。形は api.md の「更新の知らせ」。
// 申請が来た・直された時だけ鳴らし、取り下げ・回答・配送は音なしでバッジと一覧だけを更新する。
import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { type Db, all, get, run } from "./db.ts";
import { displayLabel, headline } from "./decisions.ts";
import type { EventHub, UserEvent } from "./events.ts";
import { GoogleToken, type ServiceAccount } from "./google-auth.ts";

export type ApnsConfig = { keyPem: string; keyId: string; teamId: string; topic: string };
type Send = (env: "sandbox" | "production", token: string, headers: Record<string, string>, payload: unknown) => Promise<{ status: number; reason?: string }>;
export type FcmConfig = { projectId: string; serviceAccount: ServiceAccount; fetch?: typeof fetch };
type FcmSend = (token: string, data: Record<string, string>, priority: "high" | "normal") => Promise<{ status: number; reason?: string }>;

const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
const TOKEN_TTL_MS = 50 * 60_000; // Appleは20〜60分で作り直すよう求めている

export class Apns {
  private readonly config: ApnsConfig;
  private readonly key: KeyObject;
  private jwt: { value: string; at: number } | null = null;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(config: ApnsConfig) {
    this.config = config;
    this.key = createPrivateKey(config.keyPem);
  }

  private token(): string {
    if (this.jwt && Date.now() - this.jwt.at < TOKEN_TTL_MS) return this.jwt.value;
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "ES256", kid: this.config.keyId })}.${enc({ iss: this.config.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign("sha256", Buffer.from(head), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { value: `${head}.${signature}`, at: Date.now() };
    return this.jwt.value;
  }

  private session(env: "sandbox" | "production"): ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(HOSTS[env]);
    session.on("error", () => this.sessions.delete(env));
    session.on("close", () => this.sessions.delete(env));
    session.unref();
    this.sessions.set(env, session);
    return session;
  }

  readonly send: Send = (env, deviceToken, headers, payload) => new Promise((resolve) => {
    const request = this.session(env).request({
      ":method": "POST", ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${this.token()}`, "apns-topic": this.config.topic, ...headers,
    });
    let status = 0;
    let body = "";
    request.setTimeout(10_000, () => { request.close(); resolve({ status: 0, reason: "timeout" }); });
    request.on("response", (h) => { status = Number(h[":status"]); });
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      let reason: string | undefined;
      try { reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined; } catch { /* 本文が無い */ }
      resolve({ status, ...(reason ? { reason } : {}) });
    });
    request.on("error", (error) => resolve({ status: 0, reason: error.message }));
    request.end(JSON.stringify(payload));
  });
}

/** Android へ FCM HTTP v1 でデータメッセージを送る。認証はサーバーのサービスアカウント。 */
export class Fcm {
  private readonly config: FcmConfig;
  private readonly token: GoogleToken;

  constructor(config: FcmConfig) {
    this.config = config;
    this.token = new GoogleToken(config.serviceAccount, "https://www.googleapis.com/auth/firebase.messaging", () => config.fetch ?? fetch);
  }

  readonly send: FcmSend = async (deviceToken, data, priority) => {
    let auth: string;
    try { auth = await this.token.get(); } catch (error) { return { status: 0, reason: `oauth ${(error as Error).message}` }; }
    try {
      const res = await (this.config.fetch ?? fetch)(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: deviceToken, data, android: { priority } } }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const reason = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status;
      return { status: res.status, ...(reason ? { reason } : {}) };
    } catch (error) {
      return { status: 0, reason: (error as Error).message };
    }
  };
}

/** イベントを見て、利用者のiPhone・Mac・Androidへ通知を送る。送れなかった端末のtokenが無効なら消す。 */
export class Notifier {
  private readonly db: Db;
  private readonly apns?: Send;
  private readonly fcm?: FcmSend;

  constructor(db: Db, events: EventHub, senders: { apns?: Send; fcm?: FcmSend }) {
    this.db = db;
    this.apns = senders.apns;
    this.fcm = senders.fcm;
    events.subscribeAll((userId, event) => { void this.handle(userId, event).catch(() => { /* 通知の失敗で本処理を止めない */ }); });
  }

  async handle(userId: string, event: UserEvent) {
    if (event.type !== "decision.created" && event.type !== "decision.updated") return;
    const { decision_id: id, version, change } = event.data as { decision_id: string; version: number; change?: string };
    // The server let go of a decided request's content: nothing for the user to see.
    if (change === "content_removed") return;
    const devices = all<{ id: string; platform: string; apns_token: string | null; apns_env: string | null; fcm_token: string | null; locale: Locale }>(this.db,
      "select id, platform, apns_token, apns_env, fcm_token, locale from devices where user_id = ? and ((platform = 'ios' and apns_token is not null) or (platform = 'android' and fcm_token is not null))", userId)
      .filter((d) => (d.platform === "ios" ? this.apns : this.fcm));
    if (!devices.length) return;
    // The title is opened in memory for this notification only.
    const decision = await headline(this.db, id);
    const badge = get<{ n: number }>(this.db, "select count(*) as n from decisions where user_id = ? and status = 'pending'", userId)?.n ?? 0;
    const loud = event.type === "decision.created" || change === "amended";
    const custom = { type: event.type, ...(change ? { change } : {}), decision_id: id, version };
    // 音なしでもバッジは変えるので alert として送る。background はiOSが後回しや間引きをし、バッジが古いまま残る
    const headers = { "apns-push-type": "alert", "apns-priority": "10" };
    await Promise.all(devices.map(async (device) => {
      // Translate fixed product text only; titles and requester labels remain verbatim.
      const title = !loud || !decision ? undefined : event.type === "decision.created" ? decision.title : `${({ ja: "修正", en: "Updated", ko: "수정", "zh-Hans": "已修改", "zh-Hant": "已修改" })[device.locale] ?? "修正"}: ${decision.title}`;
      if (device.platform === "android") {
        // FCM はデータメッセージだけ。値は全部文字列。title がある時だけアプリが通知を出す。
        const data: Record<string, string> = { type: event.type, ...(change ? { change } : {}), decision_id: id, version: String(version), badge: String(badge), ...(title ? { title } : {}) };
        const result = await this.fcm!(device.fcm_token!, data, title ? "high" : "normal");
        console.log(`approval-box-server: push fcm ${id} v${version} device ${device.id.slice(0, 8)} → ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
        if (result.status === 404 || result.reason === "UNREGISTERED") run(this.db, "delete from devices where id = ?", device.id);
        return;
      }
      const payload = title
        ? { aps: { alert: { title, subtitle: displayLabel(decision!) }, sound: "default", badge }, ...custom }
        : { aps: { "content-available": 1, badge }, ...custom };
      const env = device.apns_env === "sandbox" ? "sandbox" : "production";
      const result = await this.apns!(env, device.apns_token!, headers, payload);
      // tokenは書かない。届かない時に、Appleの返事を後から辿れるようにする
      console.log(`approval-box-server: push ${headers["apns-push-type"]} ${id} v${version} device ${device.id.slice(0, 8)} ${env} → ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
      if (result.status === 410 || (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))) {
        run(this.db, "delete from devices where id = ?", device.id);
      }
    }));
  }
}

/**
 * peer-channel の起こし（契約 6.3）。その K の端末へ、決まった中身の無い知らせだけを送る。題名・依頼元・ID・バッジは載せない。
 * alert（新しい申請・直し）: APNs は loc-key PC_NEW の固定文（アプリの中の訳）と mutable-content（Notification Service Extension が中身を読んで差し替える）、
 * それ以外は content-available だけ。FCM はデータだけ { pc: "1", a: "1" | "0" }。今の経路の Notifier はそのまま。
 */
export class Waker {
  private readonly db: Db;
  private readonly apns?: Send;
  private readonly fcm?: FcmSend;

  constructor(db: Db, senders: { apns?: Send; fcm?: FcmSend }) {
    this.db = db;
    this.apns = senders.apns;
    this.fcm = senders.fcm;
  }

  readonly wake = async (userId: string, alert: boolean) => {
    const devices = all<{ id: string; platform: string; apns_token: string | null; apns_env: string | null; fcm_token: string | null }>(this.db,
      "select id, platform, apns_token, apns_env, fcm_token from devices where user_id = ? and ((platform = 'ios' and apns_token is not null) or (platform = 'android' and fcm_token is not null))", userId)
      .filter((d) => (d.platform === "ios" ? this.apns : this.fcm));
    await Promise.all(devices.map(async (device) => {
      if (device.platform === "android") {
        const result = await this.fcm!(device.fcm_token!, { pc: "1", a: alert ? "1" : "0" }, alert ? "high" : "normal");
        if (result.status !== 200) console.log(`approval-box-server: wake fcm → ${result.status}${result.reason ? ` ${result.reason}` : ""}`); // K と端末は出さない
        if (result.status === 404 || result.reason === "UNREGISTERED") run(this.db, "delete from devices where id = ?", device.id);
        return;
      }
      const [headers, payload] = alert
        ? [{ "apns-push-type": "alert", "apns-priority": "10" }, { aps: { alert: { "loc-key": "PC_NEW" }, "mutable-content": 1, sound: "default" }, pc: 1 }]
        : [{ "apns-push-type": "background", "apns-priority": "5" }, { aps: { "content-available": 1 }, pc: 1 }];
      const result = await this.apns!(device.apns_env === "sandbox" ? "sandbox" : "production", device.apns_token!, headers, payload);
      if (result.status !== 200) console.log(`approval-box-server: wake apns → ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
      if (result.status === 410 || (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))) {
        run(this.db, "delete from devices where id = ?", device.id);
      }
    }));
  };
}
