import { useState } from "preact/hooks";
import { systemMessage, t } from "../i18n.ts";
import { linkProps } from "../router";
import { loadClosed, useResource } from "../store";
import { dateTime, DELIVERY_LABEL } from "../format";
import { ListFilters, matches } from "./ListFilters";
import { Plan } from "./Plan";
import { Source } from "./Source";

/** S4 履歴。履歴の削除は設定（S8 履歴の保存）だけにある。 */
export function History() {
  const { data, error, loading, noContract } = useResource(loadClosed);
  const [filter, setFilter] = useState<"all" | "answered" | "cancelled">("all");
  const [query, setQuery] = useState("");
  if (noContract) return <Plan />;
  const shown = (data ?? []).filter((d) => (filter === "all" || d.status === filter) && matches(d, query));
  return (
    <section>
      <h1>{t("履歴")}</h1>
      {error && <p class="error">{systemMessage(error)}</p>}
      {loading && !data && <p class="muted">{t("読み込み中…")}</p>}
      {data && !data.length && (
        <div class="empty">
          <p>{t("まだ履歴はありません")}</p>
          <p class="muted">{t("あなたの回答が、ここに残ります。")}</p>
        </div>
      )}
      {data && data.length > 0 && (
        <>
          <ListFilters chips={[["all", t("すべて")], ["answered", t("回答済み")], ["cancelled", t("取り下げ")]]} value={filter} onValue={setFilter} query={query} onQuery={setQuery} />
          {!shown.length && <p class="muted">{t("この条件の相談はありません")}</p>}
        </>
      )}
      <div class="cards">
        {shown.map((d) => (
          <a key={d.id} class="card closed" {...linkProps(`/d/${d.id}`, { from: "history" })}>
            <div class="card-meta">
              <Source source={d.source} />
              <span class="time">{dateTime(d.updated_at)}</span>
            </div>
            <div class="card-title">{d.title}</div>
            <div class="card-tags">
              {d.status === "cancelled"
                ? <><span class="tag">{t("取り下げ")}</span>{d.cancel_reason && <span class="tag">{d.cancel_reason}</span>}</>
                : <>
                    <span class="tag">{t("回答済み")}</span>
                    <span class="tag">{d.answer?.option_id ? d.options.find((o) => o.id === d.answer!.option_id)?.label : t("文で回答")}</span>
                    <span class={`tag delivery-${d.delivery}`}>{DELIVERY_LABEL[d.delivery ?? ""] ?? d.delivery}</span>
                  </>}
              {d.source.test && <span class="tag tag-test">{t("テスト")}</span>}
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
