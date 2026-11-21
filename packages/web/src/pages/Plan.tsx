import { libraryLogin } from "../api";
import { logout } from "../account";
import { t } from "../i18n.ts";
import { loadMe, useResource } from "../store";
import { dateOnly, planStatus } from "../format";

export const COMMERCE_URL = "https://kitepon.dev/specified-commercial-transactions/#approval-box";

/** S7 契約。設定の「契約について」から開き、契約が無い（402）時は受信・履歴・相談の代わりに出る。Webでは買えないので、買える端末への道だけを案内する。 */
export function Plan() {
  const me = useResource(loadMe).data;
  const active = me?.plan === "active";
  return (
    <section class="plan">
      <h1>{t("契約")}</h1>
      {me && (
        <div class="panel">
          <p class="plan-status"><strong>{planStatus(me)}</strong></p>
          {active && me.expires_at && me.billing !== "off" && <p>{t("期限: {date}", { date: dateOnly(me.expires_at) })}</p>}
        </div>
      )}
      {me?.billing !== "off" && (
        <div class="panel">
          <p>{t("この端末では契約できません。契約は、iPhone・iPad・Mac または Android の決裁箱で、設定 → 契約 から行います。")}</p>
          {active && libraryLogin() && <p>{t("この端末は、契約しているスマホの承認でログインしています。")}</p>}
        </div>
      )}
      {me?.billing !== "off" && <p class="muted">{t("1か月ごとの自動更新。解約は、契約したストアの管理画面から行えます。")}</p>}
      <p class="links">
        <a href="/terms.html" target="_blank" rel="noopener">{t("利用規約")}</a>
        <a href="/privacy.html" target="_blank" rel="noopener">{t("プライバシーポリシー")}</a>
        <a href={COMMERCE_URL} target="_blank" rel="noopener">{t("特定商取引法に基づく表記")}</a>
      </p>
      {me && !active && <button class="ghost" onClick={logout}>{t("ログアウト")}</button>}
    </section>
  );
}
