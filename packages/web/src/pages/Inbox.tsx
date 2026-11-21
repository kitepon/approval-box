import { useState } from "preact/hooks";
import { systemMessage, t } from "../i18n.ts";
import { linkProps } from "../router";
import { loadOpen, useResource } from "../store";
import { ago, deadlineText, URGENCY_LABEL } from "../format";
import type { Decision } from "../types";
import { ListFilters, matches } from "./ListFilters";
import { Plan } from "./Plan";
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
        <span class="tag">{d.status === "held" ? t("保留") : t("未回答")}</span>
        {amended && <span class="tag tag-amended">{t("修正あり")}</span>}
        {d.source.test && <span class="tag tag-test">{t("テスト")}</span>}
      </div>
    </a>
  );
}

/** S3 受信。契約が無い（402）時は、一覧の代わりに S7 を出す。 */
export function Inbox() {
  const { data, error, loading, noContract } = useResource(loadOpen);
  const [filter, setFilter] = useState<"all" | "pending" | "held">("all");
  const [query, setQuery] = useState("");
  if (noContract) return <Plan />;
  // 未回答（pending）を先に、保留（held）を後に並べる。
  const shown = (data ?? []).filter((d) => (filter === "all" || d.status === filter) && matches(d, query)).sort((a, b) => Number(a.status === "held") - Number(b.status === "held"));
  return (
    <section>
      <h1>{t("受信")}</h1>
      {error && <p class="error">{systemMessage(error)}</p>}
      {loading && !data && <p class="muted">{t("読み込み中…")}</p>}
      {data && !data.length && (
        <div class="empty">
          <p>{t("いま決めることはありません")}</p>
          <p class="muted">{t("相談が届いたら、お知らせします。")}</p>
        </div>
      )}
      {data && data.length > 0 && (
        <>
          <ListFilters chips={[["all", t("すべて")], ["pending", t("未回答")], ["held", t("保留")]]} value={filter} onValue={setFilter} query={query} onQuery={setQuery} />
          {!shown.length && <p class="muted">{t("この条件の相談はありません")}</p>}
          <div class="cards">{shown.map((d) => <DecisionCard key={d.id} d={d} />)}</div>
        </>
      )}
    </section>
  );
}
