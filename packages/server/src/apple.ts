// Sign in with Apple の identity token（JWT, RS256）を、Appleの公開鍵（JWKS）で確かめる。
// アプリ（ネイティブ）の token は aud がアプリの Bundle ID になる。Appleへの秘密鍵は要らない。
import { createHash, createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
import { ApiError } from "./errors.ts";

const ISSUER = "https://appleid.apple.com";
const KEYS_URL = "https://appleid.apple.com/auth/keys";
const KEYS_TTL_MS = 3600_000;
const SKEW_SECONDS = 60;

export type AppleJwk = JsonWebKeyInput["key"] & { kid: string };
export type AppleKeys = () => Promise<AppleJwk[]>;

let cache: { keys: AppleJwk[]; at: number } | null = null;

/** Appleの公開鍵。1時間覚えておき、知らない kid が来た時は取り直す。 */
export const fetchAppleKeys: AppleKeys = async () => {
  const response = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new ApiError("internal", "Appleの公開鍵を取得できませんでした。時間を置いて試してください。");
  return ((await response.json()) as { keys: AppleJwk[] }).keys;
};

async function keyFor(kid: string, keys: AppleKeys): Promise<AppleJwk | undefined> {
  if (!cache || Date.now() - cache.at > KEYS_TTL_MS || !cache.keys.some((k) => k.kid === kid)) cache = { keys: await keys(), at: Date.now() };
  return cache.keys.find((k) => k.kid === kid);
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

export async function verifyAppleIdentityToken(token: string, options: { audiences: string[]; nonce?: string; keys?: AppleKeys; now?: number }): Promise<{ sub: string; email?: string }> {
  const invalid = () => new ApiError("unauthorized", "Appleのログインを確かめられませんでした。もう一度ログインしてください。");
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try { header = decode(parts[0]!); claims = decode(parts[1]!); } catch { throw invalid(); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid();
  const jwk = await keyFor(header.kid, options.keys ?? fetchAppleKeys);
  if (!jwk) throw invalid();
  const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw invalid();
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.some((a) => options.audiences.includes(a as string))) throw invalid();
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) throw invalid();
  if (typeof claims.sub !== "string" || !claims.sub) throw invalid();
  // nonce はアプリが送った時だけ確かめる。アプリが Apple へ渡すのは生の値か、そのSHA-256のどちらか。
  if (options.nonce !== undefined && claims.nonce !== options.nonce && claims.nonce !== sha256hex(options.nonce)) throw invalid();
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

/** 試験用: 覚えた公開鍵を捨てる。 */
export function resetAppleKeyCache() { cache = null; }
