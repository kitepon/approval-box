import { t, days, locale } from "../i18n.ts";
import { useEffect, useState } from "preact/hooks";
import { api, setSession } from "../api";
import { navigate } from "../router";
import { bump, loadMe, useResource } from "../store";
import { CHECK_LABEL, clientLabel } from "../format";


type Offer = { amount: number; currency: string; interval: "month"; trial_days: number; first_charge_at: string };
const COMMERCE_URL = "https://kitepon.dev/specified-commercial-transactions/#approval-box";

function Confirmation({ offer, busy, onConfirm, onCancel }: { offer: Offer; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const date = new Date(offer.first_charge_at).toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" });
  return (
    <div class="notice">
      <h3>{t("契約内容の確認")}</h3>
      <ul>
        <li>{t("プラン：月額プラン・1か月ごと")}</li>
        <li>{t("更新：解約するまで自動更新")}</li>
        <li>{t("料金：月額{amount}円（税込）", { amount: offer.amount })}</li>
        <li>{t("支払い方法：クレジットカード、Apple Pay、Google Pay")}</li>
        <li>{offer.trial_days > 0 ? t("初回のお支払い：{date}に{amount}円（それまでの{days}日間は無料）", { date, amount: offer.amount, days: offer.trial_days }) : t("初回のお支払い：今日 {amount}円", { amount: offer.amount })}</li>
        <li>{t("サービスの開始：支払い手続きの完了後すぐ")}</li>
        <li>{t("解約：設定の「契約の管理」から。期間の終わりに終了します。")}</li>
        <li>{t("返金：支払い済みの期間の返金はありません。詳しくは特定商取引法に基づく表記をご覧ください。")}</li>
      </ul>
      <p class="muted">
        <a href="https://kitepon.dev/terms/" target="_blank" rel="noopener">{t("利用規約")}</a>{" · "}
        <a href="/terms.html" target="_blank" rel="noopener">{t("Approval Boxの付属規約")}</a>{" · "}
        <a href={COMMERCE_URL} target="_blank" rel="noopener">{t("特定商取引法に基づく表記")}</a>
      </p>
      <div class="row">
        <button disabled={busy} onClick={onConfirm}>{t("申し込む（Stripeの支払い画面へ進む）")}</button>
        <button class="ghost" disabled={busy} onClick={onCancel}>{t("やめる")}</button>
      </div>
    </div>
  );
}

export function Settings({ onLogout }: { onLogout: () => void }) {
  const PLAN_LABEL: Record<string, string> = { active: t("契約中"), expired: t("期限切れ") };
  const STORE_LABEL: Record<string, string> = { app_store: t("App Storeで契約中"), google_play: t("Google Playで契約中"), web: t("Webで契約中") };
  const me = useResource(loadMe);
  const settings = useResource(() => api<{ retention_days: number }>("GET", "/me/settings"));
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);

  // 契約の前に、料金・無料期間・初回の請求日を確認画面に出す。Stripeへ進むのは、その画面のボタンだけ。
  async function openOffer() {
    setBusy(true);
    try { setOffer(await api<Offer>("GET", "/billing/stripe/offer")); }
    catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  }

  // Stripeの画面へ移る。戻ってきた時に通知がまだなら、少し待って読み直す。
  async function goToStripe(path: "checkout" | "portal") {
    setBusy(true);
    try { window.location.href = (await api<{ url: string }>("POST", `/billing/stripe/${path}`)).url; }
    catch (e) { alert((e as Error).message); setBusy(false); }
  }
  const returning = new URLSearchParams(window.location.search).get("billing") === "success";
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!returning || me.data?.plan === "active" || tries >= 15) return;
    const timer = setTimeout(() => { setTries(tries + 1); bump(); }, 2000);
    return () => clearTimeout(timer);
  }, [returning, me.data?.plan, tries]);

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
                <p>{m.store && m.plan === "active" ? STORE_LABEL[m.store] : !m.store && m.plan !== "active" ? t("未契約") : PLAN_LABEL[m.plan] ?? m.plan}</p>
                {!m.setup.verified
                  ? <div class="notice">
                      <p>{t("契約の前に、セットアップ確認を済ませてください。答えがAIまで届くことを確かめてから契約できます。")}</p>
                      <button class="ghost" onClick={() => navigate("/connections")}>{t("接続とテストへ")}</button>
                    </div>
                  : m.plan === "active"
                    ? m.store === "web" && m.web_billing && <button class="ghost" disabled={busy} onClick={() => goToStripe("portal")}>{t("契約の管理（解約・カード変更・領収書）")}</button>
                    : m.web_billing
                      ? returning ? <p class="muted">{t("お支払いの反映を待っています。しばらくすると契約中に変わります。")}</p> : offer ? <Confirmation offer={offer} busy={busy} onConfirm={() => goToStripe("checkout")} onCancel={() => setOffer(null)} /> : <button disabled={busy} onClick={openOffer}>{t("Webで契約する")}</button>
                      : <p class="muted">{t("Webでの契約（Stripe）は準備中です。")}</p>}
                <p class="muted"><a href={COMMERCE_URL} target="_blank" rel="noopener">{t("特定商取引法に基づく表記")}</a></p>
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
        <h2>{t("Linux版アプリ")}</h2>
        <p class="muted">{t("Ubuntu 24.04以降・Debian 13以降（amd64）向けの.debです。自動更新はないので、新しい版は入れ直してください。")}</p>
        {/* shortcut: releases/latest assumes every release in this repo is the Linux app, change it if other releases are added */}
        <a href="https://github.com/kitepon/approval-box/releases/latest" target="_blank" rel="noopener">{t("ダウンロード（GitHub）")}</a>
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
