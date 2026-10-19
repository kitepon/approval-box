import { t, days } from "../i18n.ts";
import { useState } from "preact/hooks";
import { api, setSession } from "../api";
import { navigate } from "../router";
import { bump, loadMe, useResource } from "../store";
import { CHECK_LABEL, clientLabel } from "../format";


export function Settings({ onLogout }: { onLogout: () => void }) {
  const PLAN_LABEL: Record<string, string> = { trial: t("無料体験"), active: t("契約中"), expired: t("期限切れ") };
  const STORE_LABEL: Record<string, string> = { app_store: t("App Storeで契約中"), google_play: t("Google Playで契約中"), web: t("Webで契約中") };
  const me = useResource(loadMe);
  const settings = useResource(() => api<{ retention_days: number }>("GET", "/me/settings"));
  const [busy, setBusy] = useState(false);

  async function setRetention(days: number) {
    try { await api("PATCH", "/me/settings", { retention_days: days }); bump(); } catch (e) { alert((e as Error).message); }
  }
  async function deleteHistory() {
    if (!confirm(t("答え済みの履歴を全部消します。未決は残ります。よろしいですか？"))) return;
    setBusy(true);
    try { const r = await api<{ deleted: number }>("DELETE", "/decisions?status=answered,cancelled"); alert(t("{count}件消しました。", { count: r.deleted })); bump(); }
    catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  }
  async function deleteAccount() {
    if (!confirm(t("アカウントと全データ（未決も含む）を削除します。元に戻せません。よろしいですか？"))) return;
    if (prompt(t("確認のため「削除」と入力してください")) !== t("削除")) return;
    try { await api("DELETE", "/me"); setSession(null); onLogout(); } catch (e) { alert((e as Error).message); }
  }
  async function logout() {
    try { await api("POST", "/auth/logout"); } catch { /* 期限切れでも続ける */ }
    setSession(null);
    onLogout();
  }

  const m = me.data;
  return (
    <section>
      <h1>{t("設定")}</h1>
      {m && <div class="panel"><h2>{t("ログイン")}</h2><p>{m.login === "google" ? t("Googleでログインしています。") : m.login === "apple" ? t("Appleでログインしています。") : t("AppleでもGoogleでもないログインで使っています（廃止した入口）。")}</p></div>}
      {m && (
        <div class="panel">
          <h2>{t("契約")}</h2>
          {m.billing === "off"
            ? <p class="muted">{t("このサーバーは自分で立てたもので、料金はかかりません。")}</p>
            : <>
                <p>{m.store && m.plan === "active" ? STORE_LABEL[m.store] : PLAN_LABEL[m.plan] ?? m.plan}</p>
                {!m.setup.verified
                  ? <div class="notice">
                      <p>{t("契約の前に、セットアップ確認を済ませてください。答えがAIまで届くことを確かめてから契約できます。")}</p>
                      <button class="ghost" onClick={() => navigate("/connections")}>{t("接続とテストへ")}</button>
                    </div>
                  : m.plan !== "active" && <p class="muted">{t("Webでの契約（Stripe）は準備中です。")}</p>}
                {m.setup.checks.some((c) => c.status !== "passed") && m.setup.verified && (
                  <ul class="checks">
                    {m.setup.checks.filter((c) => c.status !== "passed").map((c) => <li key={c.connection_id + c.client}>{t("{client}はまだ確認できていません（{status}）", { client: clientLabel(c.client), status: CHECK_LABEL[c.status] ?? c.status })}</li>)}
                  </ul>
                )}
              </>}
        </div>
      )}
      <div class="panel">
        <h2>{t("既決の保存")}</h2>
        <label class="field">
          <span>{t("答え済みの申請を自動で消すまでの日数")}</span>
          <select value={settings.data?.retention_days ?? 30} onChange={(e) => setRetention(Number((e.target as HTMLSelectElement).value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{days(d)}</option>)}
          </select>
        </label>
        <button class="ghost danger" disabled={busy} onClick={deleteHistory}>{t("既決の履歴を削除")}</button>
      </div>
      <div class="panel">
        <h2>{t("アカウント")}</h2>
        <div class="row">
          <button class="ghost" onClick={logout}>{t("ログアウト")}</button>
          <button class="ghost danger" onClick={deleteAccount}>{t("アカウントと全データを削除")}</button>
        </div>
      </div>
    </section>
  );
}
