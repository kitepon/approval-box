import { t, languagePreference, setLanguage, type LanguagePreference } from "./i18n.ts";

/** 言語の選び方は1つ。ログイン（S1）と設定（S8）にだけ置く。 */
export function LanguagePicker({ labelled = true }: { labelled?: boolean }) {
  const select = (
    <select aria-label={t("言語")} value={languagePreference()} onChange={(event) => setLanguage((event.target as HTMLSelectElement).value as LanguagePreference)}>
      <option value="system">{t("システムに合わせる")}</option><option value="ja">日本語</option><option value="en">English</option><option value="ko">한국어</option><option value="zh-Hans">简体中文</option><option value="zh-Hant">繁體中文</option>
    </select>
  );
  return labelled ? <label class="language-picker"><span>{t("言語")}</span>{select}</label> : <div class="language-picker">{select}</div>;
}
