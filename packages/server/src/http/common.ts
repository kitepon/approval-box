import type { Context } from "hono";
import type { z } from "zod";
import type { Services } from "./types.ts";
import { requestLocale } from "../locale.ts";
import { type Attachment, contentDisposition } from "../attachments.ts";
import { get, run } from "../db.ts";
import { ApiError } from "../errors.ts";
import { now } from "../ids.ts";

export function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try { raw = JSON.parse(text); } catch { throw new ApiError("validation_failed", "本文がJSONではありません。"); }
  }
  return schema.parse(raw);
}

/** 書き込みの冪等キー。同期の変更処理と初回応答の記録の間では実行を譲らない。 */
export function idempotent(c: Context, services: Services, userId: string, fn: () => Record<string, unknown>) {
  const key = c.req.header("idempotency-key");
  const route = `${c.req.method} ${c.req.path}`;
  if (key) {
    const saved = get<{ route: string; status: number; body: string }>(services.db, "select route, status, body from idempotency where user_id = ? and key = ?", userId, key);
    if (saved) {
      if (saved.route !== route) throw new ApiError("validation_failed", "同じIdempotency-Keyが別の操作に使われています。");
      return c.body(saved.body, saved.status as 200, { "content-type": "application/json" });
    }
  }
  let status = 200;
  let payload: unknown;
  try {
    payload = fn();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500 || error.code === "rate_limited") throw error;
    status = error.status;
    payload = error.body(requestLocale(c.req.header("Accept-Language")));
  }
  const text = JSON.stringify(payload);
  if (key) run(services.db, "insert or replace into idempotency (user_id, key, route, status, body, created_at) values (?, ?, ?, ?, ?, ?)", userId, key, route, status, text, now());
  return c.body(text, status as 200, { "content-type": "application/json" });
}

/** 添付の中身を返す。ブラウザで開かれても実行されないよう、ダウンロード扱いにして中身の推測を止める。 */
export function fileResponse(c: Context, meta: Attachment, data: Buffer) {
  return c.body(new Uint8Array(data), 200, {
    "content-type": meta.content_type,
    "content-length": String(data.length),
    "content-disposition": contentDisposition(meta.name),
    "etag": `"${meta.sha256}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

export function files(services: Services) {
  if (!services.attachments) throw new ApiError("not_found", "このサーバーでは添付を使えません。");
  return services.attachments;
}

/** 消した行のファイルを片付ける。失敗しても操作は確定済み。 */
export function sweep(services: Services) {
  try { services.attachments?.gc(); } catch (error) { console.error(error); }
}
