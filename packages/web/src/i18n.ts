import { useEffect, useState } from "preact/hooks";
import { en, type MessageKey } from "./messages.ts";

export type Locale = "ja" | "en";
export type LanguagePreference = Locale | "system";
const STORAGE_KEY = "approval-box.language";
export function resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "ja" || base === "en") return base;
  }
  return "ja";
}
function storedPreference(): LanguagePreference {
  try { const value = localStorage.getItem(STORAGE_KEY); return value === "ja" || value === "en" ? value : "system"; }
  catch { return "system"; }
}
let preference = storedPreference();
const listeners = new Set<() => void>();
export const languagePreference = () => preference;
export const locale = () => resolveLocale(preference, typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);
function changed() {
  if (typeof document !== "undefined") document.documentElement.lang = locale();
  for (const notify of listeners) notify();
}
export function setLanguage(value: LanguagePreference) {
  preference = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the choice for this page even if persistence is blocked. */ }
  changed();
}
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", changed);
  window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY || event.key === null) { preference = storedPreference(); changed(); } });
  changed();
}
export function useLocale(): Locale {
  const [, update] = useState(0);
  useEffect(() => { const notify = () => update((value) => value + 1); listeners.add(notify); return () => { listeners.delete(notify); }; }, []);
  return locale();
}
export function translate(language: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const message: string = language === "en" ? en[key] : key;
  // A replacement function treats user-supplied $&, braces and markup as literal text.
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] === undefined ? placeholder : typeof values[name] === "number" ? new Intl.NumberFormat(language).format(values[name]) : String(values[name]));
}
export const t = (key: MessageKey, values?: Record<string, string | number>) => translate(locale(), key, values);
/** Getters keep module-level labels current when the language changes. */
export function labels(source: Record<string, MessageKey>): Record<string, string> {
  return Object.defineProperties({}, Object.fromEntries(Object.entries(source).map(([key, message]) => [key, { enumerable: true, get: () => t(message) }])));
}
export function relative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(locale(), { numeric: "always" }).format(value, unit);
}
export function days(count: number): string {
  return locale() === "ja" ? t("{count}日", { count }) : new Intl.NumberFormat("en", { style: "unit", unit: "day", unitDisplay: "long" }).format(count);
}
