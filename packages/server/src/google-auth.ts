// Googleのサービスアカウントで、APIのアクセストークンを得る（Google Play・FCMで共用）。依存を足さず node:crypto で署名する。
import { sign } from "node:crypto";

export type ServiceAccount = { client_email: string; private_key: string };
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleToken {
  private cached?: { value: string; until: number };

  private readonly account: ServiceAccount;
  private readonly scope: string;
  private readonly fetchFn: () => typeof fetch;

  constructor(account: ServiceAccount, scope: string, fetchFn: () => typeof fetch = () => fetch) {
    this.account = account;
    this.scope = scope;
    this.fetchFn = fetchFn;
  }

  /** 期限の1分前まで使い回す。失敗は理由だけを持つ Error（鍵や本文は入れない）。 */
  async get(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    const iat = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: this.account.client_email, scope: this.scope, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let assertion: string;
    try {
      assertion = `${input}.${sign("RSA-SHA256", Buffer.from(input), this.account.private_key).toString("base64url")}`;
    } catch {
      throw new Error("sign failed");
    }
    let res: Response;
    try {
      res = await this.fetchFn()(TOKEN_URL, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      });
    } catch {
      throw new Error("unreachable");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== "string") throw new Error(`${res.status} ${String(json.error ?? "")}`);
    this.cached = { value: json.access_token, until: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60_000 };
    return json.access_token;
  }
}
