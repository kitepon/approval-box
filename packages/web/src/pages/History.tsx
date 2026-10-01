import { useState } from "preact/hooks";
import { api } from "../api";
import { linkProps } from "../router";
import { bump, loadClosed, useResource } from "../store";
import { clientLabel, dateTime, DELIVERY_LABEL } from "../format";

export function History() {
  const { data, error, loading } = useResource(loadClosed);
  const [busy, setBusy] = useState(false);

  async function deleteAll() {
    if (!confirm("答え済みの履歴を全部消します。未決は残ります。よろしいですか？")) return;
    setBusy(true);
    try { await api("DELETE", "/decisions?status=answered,cancelled"); bump(); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <h1>既決</h1>
      {error && <p class="error">{error}</p>}
      {loading && !data && <p class="muted">読み込み中…</p>}
      {data && !data.length && <p class="muted">まだ答えた申請はありません。</p>}
      <div class="cards">
        {data?.map((d) => (
          <a key={d.id} class="card closed" {...linkProps(`/d/${d.id}`)}>
            <div class="card-meta">
              <span class="chip">{clientLabel(d.source.client)}</span>
              <span class="session">{d.source.session_label}</span>
              <span class="time">{dateTime(d.updated_at)}</span>
            </div>
            <div class="card-title">{d.title}</div>
            <div class="card-tags">
              {d.status === "cancelled"
                ? <span class="tag">AIが取り下げ{d.cancel_reason ? `: ${d.cancel_reason}` : ""}</span>
                : <>
                    <span class="tag">{d.answer?.option_id ? d.options.find((o) => o.id === d.answer!.option_id)?.label : "文で回答"}</span>
                    <span class={`tag delivery-${d.delivery}`}>{DELIVERY_LABEL[d.delivery ?? ""] ?? d.delivery}</span>
                  </>}
              {d.source.test && <span class="tag tag-test">テスト</span>}
            </div>
          </a>
        ))}
      </div>
      {data && data.length > 0 && <button class="ghost danger" disabled={busy} onClick={deleteAll}>既決の履歴を削除</button>}
    </section>
  );
}
