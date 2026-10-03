// 利用者が答えに付けた添付を、この端末の ~/.approval-box/attachments/<決裁ID>/ へ保存する（api.md「添付（v0.23）」）。
// 配送デーモンは答えを届ける前に保存して場所を文に書き足し、MCPの get_attachment は取り直しに使う。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "./api.ts";
import { home } from "./profile.ts";

export type AttachmentMeta = { id: string; name: string; content_type: string; kind?: string; size: number; sha256: string };

const KEEP_DAYS = 30;

export const attachmentsRoot = () => join(home(), "attachments");

/** どのOSでもファイル名に使える形にする（Windowsの禁止文字・末尾の点や空白を除く）。 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  return cleaned.slice(0, 150) || "file";
}

/** 1つ保存して場所を返す。同じ中身が既にあれば取り直さない。中身のSHA-256がサーバーの値と合わなければ保存しない。 */
export async function saveAttachment(api: Api, decisionId: string, meta: AttachmentMeta, index: number): Promise<string> {
  const dir = join(attachmentsRoot(), safeFileName(decisionId));
  const file = join(dir, `${index + 1}_${safeFileName(meta.name)}`);
  if (existsSync(file) && sha256(readFileSync(file)) === meta.sha256) return file;
  const data = await api.download(`/decisions/${encodeURIComponent(decisionId)}/attachments/${encodeURIComponent(meta.id)}`);
  if (sha256(data) !== meta.sha256) throw new Error(`${meta.name} の中身がサーバーの記録と合いません（取り直してください）`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  return file;
}

/** 答えの文に書き足す、保存した場所の一覧。保存できなかったものは get_attachment を案内する。 */
export async function saveAll(api: Api, decisionId: string, items: AttachmentMeta[]): Promise<string> {
  const lines = ["", "添付はこの端末に保存しました:"];
  for (const [i, meta] of items.entries()) {
    try {
      lines.push(`${i + 1}. ${await saveAttachment(api, decisionId, meta, i)}`);
    } catch (error) {
      lines.push(`${i + 1}. ${meta.name}: 保存できませんでした（${(error as Error).message}）。get_attachment で取ってください。`);
    }
  }
  return lines.join("\n");
}

/** 30日より古い保存を消す。 */
export function pruneAttachments() {
  const root = attachmentsRoot();
  if (!existsSync(root)) return;
  const before = Date.now() - KEEP_DAYS * 86400_000;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try { if (statSync(dir).mtimeMs < before) rmSync(dir, { recursive: true, force: true }); } catch { /* 先に消えた */ }
  }
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
