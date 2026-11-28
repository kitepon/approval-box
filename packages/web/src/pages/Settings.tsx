import { t, days } from "../i18n.ts";
import { useState } from "preact/hooks";
import { api, downloadExport } from "../api";
import { logout } from "../account";
import { showAlert } from "../dialog";
import { LanguagePicker } from "../language";
import { linkProps } from "../router";
import { bump, loadMe, localHistory, useResource } from "../store";
import { dateOnly, planStatus } from "../format";

/** S8 設定。節の順は docs/architecture/screens.md のとおり。Webには通知が無いので、「通知」の節はその旨だけを言う。
 * The browser is a child device: it cannot buy, and it cannot delete the account (a signed DELETE /me is 409); it leaves with ログアウト. */
export function Settings() {
  const me = useResource(loadMe);
  const settings = useResource(() => api<{ retention_days: number }>("GET", "/me/settings"));
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);

  async function setRetention(days: number) {
    try { await api("PATCH", "/me/settings", { retention_days: days }); localHistory.setRetention(days); bump(); } catch (e) { showAlert((e as Error).message); }
  }
  async function deleteHistory() {
    if (!confirm(t("答え済みの履歴を全部消します。未決は残ります。よろしいですか？"))) return;
    setBusy(true);
    // The server's decided requests and this browser's history (mostly the same requests, so the larger count).
    try { const r = await api<{ deleted: number }>("DELETE", "/decisions?status=answered,cancelled"); setDeleted(Math.max(r.deleted, await localHistory.clear())); bump(); }
    catch (e) { showAlert((e as Error).message); } finally { setBusy(false); }
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
          <p>{t("スマホの承認でログインしています")}</p>
        </div>
      )}
      {m && (
        <div class="panel">
          <h2>{t("契約")}</h2>
          <p>{m.plan || m.billing === "off" ? planStatus(m) : t("この端末では契約できません。契約は、iPhone・iPad・Mac または Android の決裁箱で、設定 → 契約 から行います。")}</p>
          {m.plan === "active" && m.expires_at && m.billing !== "off" && <p>{t("期限: {date}", { date: dateOnly(m.expires_at) })}</p>}
          <a class="button-link" {...linkProps("/plan")}>{t("契約について")}</a>
        </div>
      )}
      <div class="panel">
        <h2>{t("ほかの端末")}</h2>
        <p class="muted">{t("この端末は、ほかの端末をログインさせられません。止めるときは、承認したスマホの 設定 → ほかの端末 から止めます。")}</p>
      </div>
      <div class="panel">
        <h2>{t("通知")}</h2>
        <p class="muted">{t("ブラウザ版には通知がありません。通知はスマホとPCのアプリで受け取れます。")}</p>
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
      </div>
      <div class="panel">
        <h2>{t("アカウント管理")}</h2>
        <div class="row">
          <button class="ghost" onClick={exportCopy}>{t("保存されている情報の写しを受け取る")}</button>
          <button class="ghost" onClick={logout}>{t("ログアウト")}</button>        </div>
      </div>
    </section>
  );
}
