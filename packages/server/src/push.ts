// アプリへのプッシュ通知（今はiPhone＝APNsだけ。Android＝FCMは後で足す）。形は api.md の「更新の知らせ」。
// 申請が来た・直された時だけ鳴らし、取り下げ・回答・配送は音なしでバッジと一覧だけを更新する。
import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { type Db, all, get, run } from "./db.ts";
import type { EventHub, UserEvent } from "./events.ts";

export type ApnsConfig = { keyPem: string; keyId: string; teamId: string; topic: string };
type Send = (env: "sandbox" | "production", token: string, headers: Record<string, string>, payload: unknown) => Promise<{ status: number; reason?: string }>;

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

/** イベントを見て、利用者のiPhoneへ通知を送る。送れなかった端末のtokenが無効なら消す。 */
export class Notifier {
  private readonly db: Db;
  private readonly send: Send;

  constructor(db: Db, events: EventHub, send: Send) {
    this.db = db;
    this.send = send;
    events.subscribeAll((userId, event) => { void this.handle(userId, event).catch(() => { /* 通知の失敗で本処理を止めない */ }); });
  }

  async handle(userId: string, event: UserEvent) {
    if (event.type !== "decision.created" && event.type !== "decision.updated") return;
    const { decision_id: id, version, change } = event.data as { decision_id: string; version: number; change?: string };
    const devices = all<{ id: string; apns_token: string; apns_env: string | null }>(this.db, "select id, apns_token, apns_env from devices where user_id = ? and platform = 'ios' and apns_token is not null", userId);
    if (!devices.length) return;
    const decision = get<{ title: string }>(this.db, "select title from decisions where id = ?", id);
    const badge = get<{ n: number }>(this.db, "select count(*) as n from decisions where user_id = ? and status = 'pending'", userId)?.n ?? 0;
    const loud = event.type === "decision.created" || change === "amended";
    const title = !loud || !decision ? undefined : event.type === "decision.created" ? decision.title : `修正: ${decision.title}`;
    const custom = { type: event.type, ...(change ? { change } : {}), decision_id: id, version };
    const payload = title
      ? { aps: { alert: { title }, sound: "default", badge }, ...custom }
      : { aps: { "content-available": 1, badge }, ...custom };
    const headers = title
      ? { "apns-push-type": "alert", "apns-priority": "10" }
      : { "apns-push-type": "background", "apns-priority": "5" };
    await Promise.all(devices.map(async (device) => {
      const env = device.apns_env === "sandbox" ? "sandbox" : "production";
      const result = await this.send(env, device.apns_token, headers, payload);
      // tokenは書かない。届かない時に、Appleの返事を後から辿れるようにする
      console.log(`approval-box-server: push ${headers["apns-push-type"]} ${id} v${version} device ${device.id.slice(0, 8)} ${env} → ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
      if (result.status === 410 || (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))) {
        run(this.db, "delete from devices where id = ?", device.id);
      }
    }));
  }
}
