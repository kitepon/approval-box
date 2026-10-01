// GoogleとAppleのログインの ID token（JWT, RS256）を、それぞれの公開鍵（JWKS）で確かめる。
// アプリ（ネイティブ）の token は aud がアプリのクライアントID（AppleはBundle ID）になる。秘密鍵は要らない。
import { createHash, createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
import { ApiError } from "./errors.ts";

export type Provider = "apple" | "google";
export type Jwk = JsonWebKeyInput["key"] & { kid: string };
export type KeySource = (provider: Provider) => Promise<Jwk[]>;

const PROVIDERS: Record<Provider, { label: string; issuers: string[]; keysUrl: string }> = {
  apple: { label: "Apple", issuers: ["https://appleid.apple.com"], keysUrl: "https://appleid.apple.com/auth/keys" },
  google: { label: "Google", issuers: ["https://accounts.google.com", "accounts.google.com"], keysUrl: "https://www.googleapis.com/oauth2/v3/certs" },
};
const KEYS_TTL_MS = 3600_000;
const SKEW_SECONDS = 60;

const cache = new Map<Provider, { keys: Jwk[]; at: number }>();

/** 公開鍵を取りに行く。1時間覚えておき、知らない kid が来た時は取り直す。 */
export const fetchKeys: KeySource = async (provider) => {
  const response = await fetch(PROVIDERS[provider].keysUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new ApiError("internal", `${PROVIDERS[provider].label}の公開鍵を取得できませんでした。時間を置いて試してください。`);
  return ((await response.json()) as { keys: Jwk[] }).keys;
};

async function keyFor(provider: Provider, kid: string, keys: KeySource): Promise<Jwk | undefined> {
  const saved = cache.get(provider);
  if (!saved || Date.now() - saved.at > KEYS_TTL_MS || !saved.keys.some((k) => k.kid === kid)) cache.set(provider, { keys: await keys(provider), at: Date.now() });
  return cache.get(provider)!.keys.find((k) => k.kid === kid);
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

export async function verifyIdToken(provider: Provider, token: string, options: { audiences: string[]; nonce?: string; keys?: KeySource; now?: number }): Promise<{ sub: string; email?: string }> {
  const { label, issuers } = PROVIDERS[provider];
  const invalid = () => new ApiError("unauthorized", `${label}のログインを確かめられませんでした。もう一度ログインしてください。`);
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try { header = decode(parts[0]!); claims = decode(parts[1]!); } catch { throw invalid(); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid();
  const jwk = await keyFor(provider, header.kid, options.keys ?? fetchKeys);
  if (!jwk) throw invalid();
  const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw invalid();
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issuers.includes(claims.iss as string) || !audiences.some((a) => options.audiences.includes(a as string))) throw invalid();
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) throw invalid();
  if (typeof claims.sub !== "string" || !claims.sub) throw invalid();
  // nonce はアプリが送った時だけ確かめる。アプリが渡すのは生の値か、そのSHA-256のどちらか。
  if (options.nonce !== undefined && claims.nonce !== options.nonce && claims.nonce !== sha256hex(options.nonce)) throw invalid();
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

/** 試験用: 覚えた公開鍵を捨てる。 */
export function resetKeyCache() { cache.clear(); }
