import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

// 紛らわしい 0・O・1・I を除いた英大文字と数字。
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function pick(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export const decisionId = () => `K-${pick(CODE_ALPHABET, 6)}`;
export const pairingCode = () => `${pick(CODE_ALPHABET, 4)}-${pick(CODE_ALPHABET, 4)}`;
export const testCode = () => String(randomInt(100000, 1000000));
export const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** 打ち込まれたコードを正規化する。ハイフン・空白・大小文字の違いを無視する。 */
export function normalizePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== 8 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 重複検知用の件名。全角半角・大小文字・空白と記号の違いを無視する。 */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
