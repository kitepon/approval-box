import { useEffect, useState } from "preact/hooks";
import { api, fetchAttachment, uploadAttachment } from "../api";
import type { Attachment } from "../types";

// api.md「添付（v0.23）」の上限。サーバーも同じ値で断る。
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
export const MAX_COUNT = 10;

/** ブラウザが形式を付けないファイル（.md・.heic など）は拡張子から決める。 */
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const ALLOWED = new Set(Object.values(BY_EXTENSION));
export const ACCEPT = [...ALLOWED, ...Object.keys(BY_EXTENSION).map((e) => `.${e}`)].join(",");

function typeOf(file: File): string | null {
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  if (ALLOWED.has(declared)) return declared;
  return BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/** 答える前の下書き。開いた時にサーバーの下書きを取り直し、追加・個別削除する。 */
export function useDraftAttachments(decisionId: string, open: boolean) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api<{ items: Attachment[] }>("GET", `/decisions/${encodeURIComponent(decisionId)}/attachments`)
      .then((r) => alive && setItems(r.items)).catch(() => { /* 下書きが取れなくても答えられる */ });
    return () => { alive = false; };
  }, [decisionId, open]);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    let list = items;
    for (const file of [...files]) {
      const type = typeOf(file);
      if (!type) { setError(`${file.name}: この形式は付けられません。`); continue; }
      if (file.size > MAX_FILE) { setError(`${file.name}: 1つのファイルは20MBまでです。`); continue; }
      if (list.length >= MAX_COUNT) { setError(`添付は${MAX_COUNT}ファイルまでです。`); break; }
      if (list.reduce((n, a) => n + a.size, 0) + file.size > MAX_TOTAL) { setError("添付は合計50MBまでです。"); continue; }
      setUploading((n) => n + 1);
      try {
        const added = await uploadAttachment(decisionId, file, file.name, type);
        list = [...list.filter((a) => a.id !== added.id), added];
        setItems(list);
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api("DELETE", `/decisions/${encodeURIComponent(decisionId)}/attachments/${encodeURIComponent(id)}`);
      setItems((list) => list.filter((a) => a.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { items, uploading, error, add, remove };
}

/** 添付の一覧。画像は小さく見せ、押すと保存できる。 */
export function AttachmentList({ decisionId, items, onRemove }: { decisionId: string; items: Attachment[]; onRemove?: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul class="attachments">
      {items.map((a) => <AttachmentItem key={a.id} decisionId={decisionId} item={a} {...(onRemove ? { onRemove } : {})} />)}
    </ul>
  );
}

function AttachmentItem({ decisionId, item, onRemove }: { decisionId: string; item: Attachment; onRemove?: (id: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const viewable = item.kind === "image" && item.content_type !== "image/heic" && item.content_type !== "image/heif";

  useEffect(() => {
    if (!viewable) return;
    let alive = true;
    let made: string | null = null;
    fetchAttachment(decisionId, item.id).then((blob) => {
      if (!alive) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => alive && setFailed(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [decisionId, item.id, viewable]);

  async function save() {
    try {
      const blob = await fetchAttachment(decisionId, item.id);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = item.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <li class="attachment">
      {url ? <img src={url} alt={item.name} onClick={save} /> : <span class="attachment-icon">{item.kind === "image" ? "画像" : "書類"}</span>}
      <button class="attachment-name" onClick={save} title="保存する">
        {item.name}
        <span class="muted">{bytes(item.size)}{failed ? "・取れませんでした" : ""}</span>
      </button>
      {onRemove && <button class="ghost small attachment-remove" onClick={() => onRemove(item.id)} aria-label={`${item.name}を外す`}>外す</button>}
    </li>
  );
}

/** AI申請画像。回答下書きと分離し、認証取得/整合性確認後に拡大する。 */
export function RequestImages({decisionId,items}:{decisionId:string;items:Attachment[]}) {
  if (!items.length) return null;
  return <div class="request-images"><h2>AIの添付画像</h2><ul class="attachments">{items.map(a=><RequestImage key={a.id} decisionId={decisionId} item={a}/>)}</ul></div>;
}
function RequestImage({decisionId,item}:{decisionId:string;item:Attachment}) {
  const [url,setUrl]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{
    let alive=true;let made:string|null=null;
    setUrl(null);setError(null);
    fetchAttachment(decisionId,item.id).then(async blob=>{
      if(blob.size!==item.size) throw new Error("画像の大きさが一致しません。");
      const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
      const hex=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
      if(hex!==item.sha256) throw new Error("画像を確認できませんでした。");
      if(alive){made=URL.createObjectURL(blob);setUrl(made);}
    }).catch(e=>alive&&setError((e as Error).message));
    return ()=>{alive=false;if(made)URL.revokeObjectURL(made);};
  },[decisionId,item.id,item.sha256,retry]);
  return <li class="attachment">
    {url ? <button class="ghost" onClick={()=>setExpanded(true)} aria-label={`${item.name}を拡大`}><img src={url} alt={item.name} onError={()=>setError("この画像はブラウザで表示できません。原本を保存して開いてください。")}/></button> : <span>画像を読み込み中…</span>}
    <button class="attachment-name" disabled={!url} onClick={()=>setExpanded(true)} title="拡大する">{item.name}<span class="muted"> {bytes(item.size)}</span></button>
    {error&&<div role="alert">{error} <button onClick={()=>setRetry(n=>n+1)}>再読込</button></div>}
    {url&&<a href={url} download={item.name}>原本を保存</a>}
    {expanded&&url&&<div class="image-overlay" role="dialog" aria-modal="true" aria-label={item.name} onKeyDown={e=>{if(e.key==="Escape")setExpanded(false);}}>
      <button autoFocus onClick={()=>setExpanded(false)}>閉じる</button><img src={url} alt={item.name}/>
    </div>}
  </li>;
}
