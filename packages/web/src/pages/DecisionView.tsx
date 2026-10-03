import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { navigate } from "../router";
import { bump, useBump } from "../store";
import { ago, clientLabel, dateTime, deadlineText, DELIVERY_LABEL, FIELD_LABEL, URGENCY_LABEL } from "../format";
import type { Decision } from "../types";
import { ACCEPT, AttachmentList, MAX_COUNT, useDraftAttachments } from "./Attachments";

/** 背景はプレーンテキストで出す。リンクは押した時に確かめてから開く（AI経由で混じった文面への備え）。 */
function PlainText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"'）)]+)/g);
  return (
    <div class="context">
      {parts.map((part, i) => i % 2 === 1
        ? <a key={i} href={part} rel="noopener noreferrer" target="_blank">{part}</a>
        : <span key={i}>{part}</span>)}
    </div>
  );
}

export function DecisionView({ id }: { id: string }) {
  const tick = useBump();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const shown = useRef<Decision | null>(null);
  const drafts = useDraftAttachments(id, decision?.status === "pending" || decision?.status === "held");

  useEffect(() => {
    let alive = true;
    api<Decision>("GET", `/decisions/${encodeURIComponent(id)}`).then((d) => {
      if (!alive) return;
      const before = shown.current;
      if (before && before.version !== d.version && before.status !== "answered") {
        if (d.status === "cancelled") setNotice("AIがこの申請を取り下げました。");
        else if (d.history.at(-1)?.kind === "amended" && d.history.at(-1)?.by === "ai") setNotice("AIが内容を直しました。内容を確かめてから答えてください。");
      }
      shown.current = d;
      setDecision(d);
      setError(null);
    }).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id, tick]);

  if (error) return <section><p class="error">{error}</p><button class="ghost" onClick={() => navigate("/")}>受信一覧へ</button></section>;
  if (!decision) return <section><p class="muted">読み込み中…</p></section>;
  const d = decision;
  const open = d.status === "pending" || d.status === "held";
  const last = d.history.at(-1);
  const attached = drafts.items.length ? { attachment_ids: drafts.items.map((a) => a.id) } : {};

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      const updated = await api<Decision>("POST", `/decisions/${encodeURIComponent(d.id)}/${path}`, body);
      shown.current = updated;
      setDecision(updated);
      setNotice(null);
      bump();
      if (path === "answer") navigate("/");
    } catch (e) {
      if (e instanceof ApiError && e.body.decision) {
        shown.current = e.body.decision;
        setDecision(e.body.decision);
      }
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyResume() {
    try { await navigator.clipboard.writeText(d.resume_phrase); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { prompt("コピーしてください", d.resume_phrase); }
  }

  return (
    <section class="decision">
      <button class="back" onClick={() => history.length > 1 ? history.back() : navigate("/")}>‹ 戻る</button>
      {notice && <p class="notice">{notice}</p>}
      <div class="card-meta">
        <span class="chip">{clientLabel(d.source.client)}</span>
        <span class="session">{d.source.session_label}</span>
        <span class="time">{ago(d.created_at)}</span>
      </div>
      <h1>{d.title}</h1>
      <div class="card-tags">
        <span class={`tag ${d.urgency === "high" ? "tag-high" : ""}`}>{URGENCY_LABEL[d.urgency] ?? d.urgency}</span>
        {d.deadline && <span class="tag">{deadlineText(d.deadline)}</span>}
        {d.source.test && <span class="tag tag-test">テスト</span>}
        <span class="tag muted-tag">{d.id}</span>
      </div>
      {last?.kind === "amended" && last.by === "ai" && (
        <div class="amended">
          <strong>AIが修正しました</strong>（{(last.fields ?? []).map((f) => FIELD_LABEL[f] ?? f).join("・")}）
          {last.note && <div>{last.note}</div>}
        </div>
      )}
      {d.distinct_reason && <div class="amended"><strong>似た申請と別件である理由</strong><div>{d.distinct_reason}</div></div>}
      {d.context && <PlainText text={d.context} />}

      {open && (
        <div class="answer">
          <div class="options">
            {d.options.map((o) => (
              <button key={o.id} class={`option ${d.recommendation === o.id ? "recommended" : ""}`} disabled={busy || drafts.uploading > 0}
                onClick={() => act("answer", { option_id: o.id, ...(text.trim() ? { text: text.trim() } : {}), ...attached, version: d.version })}>
                {o.label}
                {d.recommendation === o.id && <span class="badge">AIの推奨</span>}
              </button>
            ))}
          </div>
          <label class="field">
            <span>添え書き・別の指示（任意）</span>
            <textarea rows={3} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="選択肢を選ばずに、文だけで指示し直すこともできます" />
          </label>
          <div class="field">
            <span>添付（画像・書類、{MAX_COUNT}ファイル・合計50MBまで。任意）</span>
            <AttachmentList decisionId={d.id} items={drafts.items} onRemove={drafts.remove} />
            {drafts.uploading > 0 && <p class="muted">アップロード中…</p>}
            {drafts.error && <p class="error">{drafts.error}</p>}
            {drafts.items.length < MAX_COUNT && (
              <label class="file-pick">
                ファイルを追加
                <input type="file" multiple accept={ACCEPT} disabled={busy} onChange={(e) => { const input = e.target as HTMLInputElement; void drafts.add(input.files).then(() => { input.value = ""; }); }} />
              </label>
            )}
          </div>
          <div class="row">
            <button class="primary" disabled={busy || drafts.uploading > 0 || (!text.trim() && !drafts.items.length)}
              onClick={() => act("answer", { ...(text.trim() ? { text: text.trim() } : {}), ...attached, version: d.version })}>
              {drafts.items.length ? (text.trim() ? "文と添付で答える" : "添付だけで答える") : "文だけで答える"}
            </button>
            {d.status === "held"
              ? <button class="ghost" disabled={busy} onClick={() => act("unhold")}>保留を戻す</button>
              : <button class="ghost" disabled={busy} onClick={() => act("hold")}>保留にする</button>}
          </div>
        </div>
      )}

      {d.status === "answered" && d.answer && (
        <div class="result">
          <div><strong>答え:</strong> {d.answer.option_id ? d.options.find((o) => o.id === d.answer!.option_id)?.label : d.answer.text ? "（文で回答）" : "（添付で回答）"}</div>
          {d.answer.text && <div class="answer-text">{d.answer.text}</div>}
          {d.answer.attachments?.length ? <AttachmentList decisionId={d.id} items={d.answer.attachments} /> : null}
          <div class={`delivery delivery-${d.delivery}`}>{DELIVERY_LABEL[d.delivery ?? ""] ?? d.delivery}</div>
          {d.delivery === "unknown" && <p class="muted">AIへ届いたか確かめられませんでした。元の会話に下の一言を送ると、AIが答えを取りに来ます。</p>}
          {d.delivery === "waiting" && d.source.via === "remote" && <p class="muted">チャットへ戻った時に、AIが答えを受け取ります。</p>}
        </div>
      )}
      {d.status === "cancelled" && <div class="result"><strong>AIが取り下げました</strong>{d.cancel_reason && <div>{d.cancel_reason}</div>}</div>}

      <button class="ghost copy" onClick={copyResume}>{copied ? "コピーしました" : "再開の一言をコピー"}</button>

      <details class="history">
        <summary>履歴</summary>
        <ul>
          {d.history.map((h, i) => (
            <li key={i}>{dateTime(h.at)} {h.by === "ai" ? "AI" : "あなた"}: {HISTORY_KIND[h.kind] ?? h.kind}{h.fields?.length ? `（${h.fields.map((f) => FIELD_LABEL[f] ?? f).join("・")}）` : ""}{h.note ? ` — ${h.note}` : ""}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const HISTORY_KIND: Record<string, string> = { created: "申請", amended: "修正", held: "保留", unheld: "保留を戻した", answered: "回答", cancelled: "取り下げ" };
