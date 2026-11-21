import { t, days } from "../i18n.ts";
import { useState } from "preact/hooks";
import { api, downloadExport, libraryLogin, setSession } from "../api";
import { logout, signedOut } from "../account";
import { showAlert } from "../dialog";
import { LanguagePicker } from "../language";
import { libraryClient } from "../librarylogin";
import { linkProps } from "../router";
import { bump, loadMe, useResource } from "../store";
import { planStatus } from "../format";

/** S8 設定。節の順は docs/architecture/screens.md のとおり。「通知」はWebに通知の設定が無いので出さない。 */
export function Settings() {
  const me = useResource(loadMe);
  const settings = useResource(() => api<{ retention_days: number }>("GET", "/me/settings"));
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);

  async function setRetention(days: number) {
    try { await api("PATCH", "/me/settings", { retention_days: days }); bump(); } catch (e) { showAlert((e as Error).message); }
  }
  async function deleteHistory() {
    if (!confirm(t("答え済みの履歴を全部消します。未決は残ります。よろしいですか？"))) return;
    setBusy(true);
    try { const r = await api<{ deleted: number }>("DELETE", "/decisions?status=answered,cancelled"); setDeleted(r.deleted); bump(); }
    catch (e) { showAlert((e as Error).message); } finally { setBusy(false); }
  }
  async function deleteAccount() {
    if (!confirm(t("アカウントと全データ（未決も含む）を削除します。元に戻せません。よろしいですか？"))) return;
    if (prompt(t("確認のため「削除」と入力してください")) !== t("削除")) return;
    try { await api("DELETE", "/me"); setSession(null); } catch (e) { showAlert((e as Error).message); return; }
    // 通行証のcookieが残ると、次に開いた時に空のアカウントを作り直すので、この端末の通行証も止める。止められなくても削除は済んでいる。
    if (libraryLogin()) await libraryClient().signOut().catch(() => {});
    signedOut();
  }
  async function exportCopy() {
    try { await downloadExport(); } catch (e) { showAlert((e as Error).message); }
  }

  const m = me.data;
  return (
    <section>
      <h1>{t("設定")}</h1>
      {m && (
        <div class="panel">
          <h2>{t("アカウント")}</h2>
          <p>{libraryLogin() ? t("スマホの承認でログインしています") : m.login === "google" ? t("Googleでログインしています") : m.login === "apple" ? t("Appleでログインしています") : t("AppleでもGoogleでもないログインで使っています（廃止した入口）。")}</p>
        </div>
      )}
      {m && (
        <div class="panel">
          <h2>{t("契約")}</h2>
          <p>{planStatus(m)}</p>
          <a class="button-link" {...linkProps("/plan")}>{t("契約について")}</a>
        </div>
      )}
      <div class="panel">
        <h2>{t("ほかの端末")}</h2>
        <p class="muted">{t("この端末は、ほかの端末をログインさせられません。止めるときは、承認したスマホの 設定 → ほかの端末 から止めます。")}</p>
      </div>
      <div class="panel">
        <h2>{t("言語")}</h2>
        <LanguagePicker labelled={false} />
      </div>
      <div class="panel">
        <h2>{t("履歴の保存")}</h2>
        <label class="field">
          <span>{t("保存期間")}</span>
          <select value={settings.data?.retention_days ?? 30} onChange={(e) => setRetention(Number((e.target as HTMLSelectElement).value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{days(d)}</option>)}
          </select>
        </label>
        <button class="ghost danger" disabled={busy} onClick={deleteHistory}>{t("履歴を削除")}</button>
        {deleted !== null && <p class="muted" role="status">{t("{count}件消しました。", { count: deleted })}</p>}
      </div>
      <div class="panel">
        <h2>{t("ヘルプ")}</h2>
        <ul class="plain">
          <li><a href="/support.html" target="_blank" rel="noopener">{t("使い方・お問い合わせ")}</a></li>
          <li><a href="/terms.html" target="_blank" rel="noopener">{t("利用規約")}</a></li>
          <li><a href="/privacy.html" target="_blank" rel="noopener">{t("プライバシーポリシー")}</a></li>
        </ul>
        <p class="muted">{t("Linux版アプリ")}: {t("Ubuntu 24.04以降・Debian 13以降（amd64）向けの.debです。自動更新はないので、新しい版は入れ直してください。")}</p>
        {/* shortcut: releases/latest assumes every release in this repo is the Linux app, change it if other releases are added */}
        <a href="https://github.com/kitepon/approval-box/releases/latest" target="_blank" rel="noopener">{t("ダウンロード（GitHub）")}</a>
      </div>
      <div class="panel">
        <h2>{t("アカウント管理")}</h2>
        <div class="row">
          <button class="ghost" onClick={exportCopy}>{t("保存されている情報の写しを受け取る")}</button>
          <button class="ghost" onClick={logout}>{t("ログアウト")}</button>
          <button class="ghost danger" onClick={deleteAccount}>{t("アカウントと全データを削除")}</button>
        </div>
      </div>
    </section>
  );
}
