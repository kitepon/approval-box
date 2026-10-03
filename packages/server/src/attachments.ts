// 答えに付ける添付（画像・書類）。api.md「添付（v0.23）」。
// 利用者は1ファイルずつ上げ（下書き）、answer の attachment_ids で答えに結ぶ。結ばれた添付は決裁と一緒に消える。
// 中身はデータの置き場の attachments/<id> に置き、表 attachments が持ち主・決裁・形式を持つ。表に行の無いファイルは gc で消す。
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, all, get, run, tx } from "./db.ts";
import { ApiError } from "./errors.ts";
import { now } from "./ids.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PER_ANSWER = 10;
export const MAX_ANSWER_BYTES = 50 * 1024 * 1024;
export const MAX_ACCOUNT_BYTES = 1024 * 1024 * 1024;
const STAGED_TTL_MS = 24 * 3600_000;
const PART_TTL_MS = 3600_000;

export type Kind = "image" | "document";
export type Attachment = { id: string; name: string; content_type: string; kind: Kind; size: number; sha256: string; created_at: string };

type Row = Attachment & { user_id: string; decision_id: string; idem_key: string | null; position: number | null };

const OOXML = "application/vnd.openxmlformats-officedocument.";
/** 許す形式と、中身の先頭がその形式かどうかの確かめ。 */
const TYPES: Record<string, { kind: Kind; sniff: (b: Buffer) => boolean }> = {
  "image/jpeg": { kind: "image", sniff: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { kind: "image", sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/gif": { kind: "image", sniff: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  "image/webp": { kind: "image", sniff: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  "image/heic": { kind: "image", sniff: isHeif },
  "image/heif": { kind: "image", sniff: isHeif },
  "application/pdf": { kind: "document", sniff: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "text/plain": { kind: "document", sniff: isUtf8Text },
  "text/markdown": { kind: "document", sniff: isUtf8Text },
  "text/csv": { kind: "document", sniff: isUtf8Text },
  "application/json": { kind: "document", sniff: isUtf8Text },
  [`${OOXML}wordprocessingml.document`]: { kind: "document", sniff: isZip },
  [`${OOXML}spreadsheetml.sheet`]: { kind: "document", sniff: isZip },
  [`${OOXML}presentationml.presentation`]: { kind: "document", sniff: isZip },
};

function isHeif(b: Buffer) {
  if (b.subarray(4, 8).toString("latin1") !== "ftyp") return false;
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"].includes(b.subarray(8, 12).toString("latin1"));
}
function isZip(b: Buffer) {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isUtf8Text(b: Buffer) {
  if (b.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

/** 表示とAIへの案内に使うファイル名。改行・制御文字・パスの区切りを除き、200字に切る。 */
export function cleanName(raw: string | undefined): string {
  const name = (raw ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, "").trim();
  return [...name].slice(0, 200).join("") || "file";
}

export function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/** 本文を上限まで読む。超えたら途中でやめて413。 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ApiError("too_large", `1つのファイルは${formatBytes(limit)}までです。`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class Attachments {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    this.db = db;
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  static toApi(row: Row): Attachment {
    return { id: row.id, name: row.name, content_type: row.content_type, kind: row.kind, size: row.size, sha256: row.sha256, created_at: row.created_at };
  }

  private open(userId: string, decisionId: string) {
    const decision = get<{ user_id: string; status: string }>(this.db, "select user_id, status from decisions where id = ?", decisionId);
    if (!decision || decision.user_id !== userId) throw new ApiError("not_found", "その申請は見つかりません。");
    return decision;
  }

  /** 下書きを1つ上げる。同じ冪等キーで同じ中身なら、前の結果を返す。 */
  upload(userId: string, decisionId: string, input: { name: string; contentType: string; idempotencyKey: string; data: Buffer }): Attachment {
    const decision = this.open(userId, decisionId);
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const previous = get<Row>(this.db, "select * from attachments where user_id = ? and idem_key = ?", userId, input.idempotencyKey);
    if (previous) {
      if (previous.decision_id !== decisionId || previous.sha256 !== sha256) throw new ApiError("validation_failed", "同じIdempotency-Keyが別のファイルに使われています。");
      return Attachments.toApi(previous);
    }
    if (decision.status !== "pending" && decision.status !== "held") throw new ApiError("conflict", decision.status === "answered" ? "この申請にはすでに答えが出ています。" : "この申請はAIが取り下げました。");
    const type = TYPES[input.contentType];
    if (!type) throw new ApiError("unsupported_type", "この形式のファイルは付けられません。画像（JPEG・PNG・HEIC・GIF・WebP）か書類（PDF・テキスト・CSV・JSON・Word・Excel・PowerPoint）を選んでください。");
    if (!input.data.length) throw new ApiError("validation_failed", "ファイルが空です。");
    if (!type.sniff(input.data)) throw new ApiError("unsupported_type", "ファイルの中身が形式と合いません。");
    const id = `att_${randomBytes(16).toString("base64url")}`;
    const part = join(this.dir, `${id}.part`);
    writeFileSync(part, input.data, { mode: 0o600 });
    try {
      const row = tx(this.db, () => {
        const staged = get<{ n: number }>(this.db, "select count(*) n from attachments where decision_id = ? and position is null", decisionId)!.n;
        if (staged >= MAX_PER_ANSWER) throw new ApiError("too_large", `1つの答えに付けられるのは${MAX_PER_ANSWER}ファイルまでです。`);
        const used = get<{ n: number | null }>(this.db, "select sum(size) n from attachments where user_id = ?", userId)!.n ?? 0;
        if (used + input.data.length > MAX_ACCOUNT_BYTES) throw new ApiError("too_large", "添付の保存がアカウントの上限（1GB）に達しました。古い既決を消すと空きます。");
        run(this.db, `insert into attachments (id, user_id, decision_id, name, content_type, kind, size, sha256, idem_key, position, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
          id, userId, decisionId, cleanName(input.name), input.contentType, type.kind, input.data.length, sha256, input.idempotencyKey, now());
        return get<Row>(this.db, "select * from attachments where id = ?", id)!;
      });
      renameSync(part, join(this.dir, id));
      return Attachments.toApi(row);
    } catch (error) {
      try { unlinkSync(part); } catch { /* 無ければよい */ }
      throw error;
    }
  }

  staged(userId: string, decisionId: string) {
    this.open(userId, decisionId);
    return { items: all<Row>(this.db, "select * from attachments where decision_id = ? and position is null order by created_at, id", decisionId).map(Attachments.toApi) };
  }

  removeStaged(userId: string, decisionId: string, id: string) {
    this.open(userId, decisionId);
    const row = get<Row>(this.db, "select * from attachments where id = ? and decision_id = ?", id, decisionId);
    if (!row) throw new ApiError("not_found", "その添付は見つかりません。");
    if (row.position !== null) throw new ApiError("conflict", "答えに付けた添付は消せません。");
    run(this.db, "delete from attachments where id = ?", id);
    this.gc();
    return { ok: true };
  }

  /** 利用者（アプリ・Web版）が中身を取る。下書きも答えに結んだ後も取れる。 */
  readForUser(userId: string, decisionId: string, id: string) {
    this.open(userId, decisionId);
    return this.read(get<Row>(this.db, "select * from attachments where id = ? and decision_id = ?", id, decisionId));
  }

  /** AI（コネクタ・リモートMCP）が中身を取る。答えに結ばれた添付だけ。決裁がその接続のものかは呼ぶ側が確かめる。 */
  readForAi(decisionId: string, id: string) {
    return this.read(get<Row>(this.db, "select * from attachments where id = ? and decision_id = ? and position is not null", id, decisionId));
  }

  private read(row: Row | undefined) {
    const file = row ? join(this.dir, row.id) : "";
    if (!row || !existsSync(file)) throw new ApiError("not_found", "その添付は見つかりません。");
    return { meta: Attachments.toApi(row), data: readFileSync(file) };
  }

  /** 結ばれないまま24時間たった下書きを消し、表に行の無いファイルを消す。 */
  gc() {
    const before = new Date(Date.now() - STAGED_TTL_MS).toISOString();
    run(this.db, "delete from attachments where position is null and created_at < ?", before);
    const ids = new Set(all<{ id: string }>(this.db, "select id from attachments").map((r) => r.id));
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      if (name.endsWith(".part")) {
        // 上げている途中のファイル。止まって残ったものだけ消す。
        try { if (Date.now() - statSync(file).mtimeMs > PART_TTL_MS) unlinkSync(file); } catch { /* 先に消えた */ }
      } else if (!ids.has(name)) {
        try { unlinkSync(file); } catch { /* 先に消えた */ }
      }
    }
  }
}

/** Content-Disposition。日本語の名前は filename* で渡し、filename には ASCII だけを残す。 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
