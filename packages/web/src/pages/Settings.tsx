import { useState } from "preact/hooks";
import { api, setSession } from "../api";
import { navigate } from "../router";
import { bump, loadMe, useResource } from "../store";
import { CHECK_LABEL, clientLabel } from "../format";

const PLAN_LABEL: Record<string, string> = { trial: "無料体験", active: "契約中", expired: "期限切れ" };
const STORE_LABEL: Record<string, string> = { app_store: "App Storeで契約中", google_play: "Google Playで契約中", web: "Webで契約中" };

export function Settings({ onLogout }: { onLogout: () => void }) {
  const me = useResource(loadMe);
  const settings = useResource(() => api<{ retention_days: number }>("GET", "/me/settings"));
  const [busy, setBusy] = useState(false);

  async function setRetention(days: number) {
    try { await api("PATCH", "/me/settings", { retention_days: days }); bump(); } catch (e) { alert((e as Error).message); }
  }
  async function deleteHistory() {
    if (!confirm("答え済みの履歴を全部消します。未決は残ります。よろしいですか？")) return;
    setBusy(true);
    try { const r = await api<{ deleted: number }>("DELETE", "/decisions?status=answered,cancelled"); alert(`${r.deleted}件消しました。`); bump(); }
    catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  }
  async function deleteAccount() {
    if (!confirm("アカウントと全データ（未決も含む）を削除します。元に戻せません。よろしいですか？")) return;
    if (prompt("確認のため「削除」と入力してください") !== "削除") return;
    try { await api("DELETE", "/me"); setSession(null); onLogout(); } catch (e) { alert((e as Error).message); }
  }
  const personal = useResource(() => api<{ exists: boolean; created_at?: string; last_used_at?: string | null }>("GET", "/me/personal-link"));
  const [personalUrl, setPersonalUrl] = useState<string | null>(null);
  async function makePersonal() {
    if (personal.data?.exists && !confirm("作り直すと、前のURLでは入れなくなります。よろしいですか？")) return;
    try { const r = await api<{ url: string }>("POST", "/me/personal-link", undefined, { idempotent: false }); setPersonalUrl(r.url); bump(); }
    catch (e) { alert((e as Error).message); }
  }
  async function revokePersonal() {
    if (!confirm("ログイン用のURLを無効にします。よろしいですか？")) return;
    try { await api("DELETE", "/me/personal-link"); setPersonalUrl(null); bump(); } catch (e) { alert((e as Error).message); }
  }

  async function logout() {
    try { await api("POST", "/auth/logout"); } catch { /* 期限切れでも続ける */ }
    setSession(null);
    onLogout();
  }

  const m = me.data;
  return (
    <section>
      <h1>設定</h1>
      <div class="panel">
        <h2>ログイン用のURL</h2>
        <p class="muted">ほかのブラウザやスマホで開くと、そのままログインできるあなた専用のURLです。ブックマークしておけば何度でも使えます。URLを知っている人は誰でもログインできるので、人に見せないでください。</p>
        {personalUrl && (
          <p><code class="copyable">{personalUrl}</code> <button onClick={() => navigator.clipboard?.writeText(personalUrl)}>コピー</button></p>
        )}
        {personalUrl && <p class="muted">このURLはいま一度だけ表示しています。ブックマークかコピーをしてください。</p>}
        {!personalUrl && personal.data?.exists && <p class="muted">作成済み{personal.data.last_used_at ? `（最後に使った日時 ${new Date(personal.data.last_used_at).toLocaleString()}）` : ""}。URLを忘れた時は作り直してください。</p>}
        <p>
          <button class="primary" onClick={makePersonal}>{personal.data?.exists ? "作り直す" : "URLを作る"}</button>{" "}
          {personal.data?.exists && <button onClick={revokePersonal}>無効にする</button>}
        </p>
      </div>
      {m && (
        <div class="panel">
          <h2>契約</h2>
          {m.billing === "off"
            ? <p class="muted">このサーバーは自分で立てたもので、料金はかかりません。</p>
            : <>
                <p>{m.store && m.plan === "active" ? STORE_LABEL[m.store] : PLAN_LABEL[m.plan] ?? m.plan}</p>
                {!m.setup.verified
                  ? <div class="notice">
                      <p>契約の前に、セットアップ確認を済ませてください。答えがAIまで届くことを確かめてから契約できます。</p>
                      <button class="ghost" onClick={() => navigate("/connections")}>接続とテストへ</button>
                    </div>
                  : m.plan !== "active" && <p class="muted">Webでの契約（Stripe）は準備中です。</p>}
                {m.setup.checks.some((c) => c.status !== "passed") && m.setup.verified && (
                  <ul class="checks">
                    {m.setup.checks.filter((c) => c.status !== "passed").map((c) => <li key={c.connection_id + c.client}>{clientLabel(c.client)}はまだ確認できていません（{CHECK_LABEL[c.status]}）</li>)}
                  </ul>
                )}
              </>}
        </div>
      )}
      <div class="panel">
        <h2>既決の保存</h2>
        <label class="field">
          <span>答え済みの申請を自動で消すまでの日数</span>
          <select value={settings.data?.retention_days ?? 30} onChange={(e) => setRetention(Number((e.target as HTMLSelectElement).value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d}日</option>)}
          </select>
        </label>
        <button class="ghost danger" disabled={busy} onClick={deleteHistory}>既決の履歴を削除</button>
      </div>
      <div class="panel">
        <h2>アカウント</h2>
        <div class="row">
          <button class="ghost" onClick={logout}>ログアウト</button>
          <button class="ghost danger" onClick={deleteAccount}>アカウントと全データを削除</button>
        </div>
      </div>
    </section>
  );
}
