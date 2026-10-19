import { t } from "../i18n.ts";
import { linkProps } from "../router";
import { loadOpen, useResource } from "../store";
import { ago, deadlineText, URGENCY_LABEL } from "../format";
import type { Decision } from "../types";
import { Source } from "./Source";

export function DecisionCard({ d }: { d: Decision }) {
  const amended = d.history.at(-1)?.kind === "amended";
  return (
    <a class={`card urgency-${d.urgency}`} {...linkProps(`/d/${d.id}`)}>
      <div class="card-meta">
        <Source source={d.source} />
        <span class="time">{ago(d.created_at)}</span>
      </div>
      <div class="card-title">{d.title}</div>
      <div class="card-tags">
        {d.urgency === "high" && <span class="tag tag-high">{URGENCY_LABEL.high}</span>}
        {d.deadline && <span class="tag">{deadlineText(d.deadline)}</span>}
        {d.status === "held" && <span class="tag">{t("保留中")}</span>}
        {amended && <span class="tag tag-amended">{t("修正あり")}</span>}
        {d.source.test && <span class="tag tag-test">{t("テスト")}</span>}
      </div>
    </a>
  );
}

export function Inbox() {
  const { data, error, loading } = useResource(loadOpen);
  const pending = data?.filter((d) => d.status === "pending") ?? [];
  const held = data?.filter((d) => d.status === "held") ?? [];
  return (
    <section>
      <h1>Approval Box</h1>
      {error && <p class="error">{error}</p>}
      {loading && !data && <p class="muted">{t("読み込み中…")}</p>}
      {data && !data.length && (
        <div class="empty">
          <p>{t("いま答えを待っている申請はありません。")}</p>
          <p class="muted">{t("AIが判断を求めると、ここに届きます。")}</p>
        </div>
      )}
      <div class="cards">{pending.map((d) => <DecisionCard key={d.id} d={d} />)}</div>
      {held.length > 0 && (
        <>
          <h2>{t("保留中")}</h2>
          <div class="cards">{held.map((d) => <DecisionCard key={d.id} d={d} />)}</div>
        </>
      )}
    </section>
  );
}
