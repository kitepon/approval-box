export const LOCALES = ["ja", "en", "ko", "zh-Hans", "zh-Hant"] as const;
export type Locale = typeof LOCALES[number];
/** Explicit Chinese script wins over region. Bare Chinese uses Simplified. */
export function supportedLocale(tag: string): Locale | undefined {
  const [base, ...parts] = tag.trim().toLowerCase().split("-");
  if (base === "ja" || base === "en" || base === "ko") return base;
  if (base !== "zh") return undefined;
  if (parts.includes("hant")) return "zh-Hant";
  if (parts.includes("hans")) return "zh-Hans";
  return parts.some(part => ["tw", "hk", "mo"].includes(part)) ? "zh-Hant" : "zh-Hans";
}
