import { KEY_HEADER } from "@kitepon/login-billing/web";
import { t, locale } from "./i18n.ts";
import { browserDevice } from "./device.ts";
import type { ApiErrorBody, Attachment } from "./types";

const v1 = (path: string) => `${location.origin}/v1${path}`;

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

/** 製品の { error: { code, message } } と、ライブラリの { error: "<code>" }（wire v1）の両方を読む。契約が無い402は、どの画面でも同じコード（subscription_expired）にする。 */
function errorBody(status: number, json: { error?: ApiErrorBody | string }): ApiErrorBody {
  const error = json.error;
  const code = typeof error === "string" ? error : error?.code;
  if (status === 402 && (code === "subscription_expired" || code === "no_entitlement")) return { code: "subscription_expired", message: t("この端末では契約できません。契約は、iPhone・iPad・Mac または Android の決裁箱で、設定 → 契約 から行います。") };
  if (typeof error === "string") return { code: error, message: `HTTP ${status}` };
  return error ?? { code: "internal", message: `HTTP ${status}` };
}

/** 401の理由はライブラリの鍵穴のコード（not_signed_in など）。画面の案内文は login.tsx の Reason が選ぶ。time_off（端末の時計のずれ）はログアウトにしない。 */
let onUnauthorized: (code?: string) => void = () => {};
export const setUnauthorizedHandler = (fn: (code?: string) => void) => { onUnauthorized = fn; };
const signedOut = (response: Response, code: string) => { if (response.status === 401 && code !== "time_off") onUnauthorized(code); };
const clockMessage = () => t("この端末の時計がずれています。時計を合わせてから、もう一度試してください。");

/**
 * One /v1 request signed with the browser's key (Login-Billing-Key, single use: every attempt signs again). The body is signed as sent.
 * No key kept (signed out, or the browser evicted it) is a 401 not_signed_in, and the page shows the QR sign-in again.
 */
async function send(method: string, path: string, headers: Record<string, string>, body?: string | Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<Response> {
  let key: string;
  try { key = await browserDevice().header(method, v1(path), body); }
  catch { onUnauthorized("not_signed_in"); throw new ApiError(401, { code: "not_signed_in", message: t("ログインが切れました。もう一度ログインしてください。") }); }
  return fetch(v1(path), { method, headers: { ...headers, [KEY_HEADER]: key }, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
}

export const isNoContract = (error: unknown) => error instanceof ApiError && error.status === 402 && error.body.code === "subscription_expired";

export async function api<T>(method: string, path: string, body?: unknown, options: { idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", "accept-language": locale() };
  if (options.idempotent ?? method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
  const key = headers["idempotency-key"];
  // 書き込みは通信が切れたら同じ冪等キーで1回だけ送り直す（二重に答えない）。
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send(method, path, headers, body !== undefined ? JSON.stringify(body) : undefined);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (attempt === 0 && key) continue;
      throw new ApiError(0, { code: "network", message: t("サーバーにつながりません。通信を確かめてください。") });
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (response.ok) return json as T;
    const err = errorBody(response.status, json);
    signedOut(response, err.code);
    if (err.code === "time_off") throw new ApiError(401, { code: "time_off", message: clockMessage() });
    if (response.status >= 500 && attempt === 0 && key) continue;
    throw new ApiError(response.status, err);
  }
}

async function failure(response: Response): Promise<ApiError> {
  const err = errorBody(response.status, await response.json().catch(() => ({})));
  signedOut(response, err.code);
  return new ApiError(response.status, err.code === "time_off" ? { code: "time_off", message: clockMessage() } : err);
}

/** 添付を1つ上げる（本文はファイルそのまま）。通信が切れたら同じ冪等キーで1回だけ送り直す。 */
export async function uploadAttachment(decisionId: string, file: Blob, name: string, contentType: string): Promise<Attachment> {
  const key = crypto.randomUUID();
  const data = new Uint8Array(await file.arrayBuffer()); // the signature covers the bytes
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send("POST", `/decisions/${encodeURIComponent(decisionId)}/attachments?name=${encodeURIComponent(name)}`, { "accept-language": locale(), "content-type": contentType, "idempotency-key": key }, data);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (attempt === 0) continue;
      throw new ApiError(0, { code: "network", message: t("サーバーにつながりません。通信を確かめてください。") });
    }
    if (response.ok) return (await response.json()) as Attachment;
    if (response.status >= 500 && attempt === 0) continue;
    throw await failure(response);
  }
}

/** 添付の中身を取る。img や a はヘッダーを付けられないので、fetch で取って Blob にする。 */
export async function fetchAttachment(decisionId: string, attachmentId: string): Promise<Blob> {
  let response: Response;
  try {
    response = await send("GET", `/decisions/${encodeURIComponent(decisionId)}/attachments/${encodeURIComponent(attachmentId)}`, { "accept-language": locale() });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, { code: "network", message: t("サーバーにつながりません。通信を確かめてください。") });
  }
  if (!response.ok) throw await failure(response);
  return response.blob();
}

/** 保存している情報の写し（GET /me/export）を取り、JSONファイルとして保存する。フォームは無く、取れたらそのまま保存する。 */
export async function downloadExport(): Promise<void> {
  let response: Response;
  try {
    response = await send("GET", "/me/export", { "accept-language": locale() });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, { code: "network", message: t("サーバーにつながりません。通信を確かめてください。") });
  }
  if (!response.ok) throw await failure(response);
  const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "approval-box-export.json";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** /v1/events を読む。EventSourceはヘッダー（署名）を付けられないので fetch で読む。切れたら間隔を延ばして張り直す。401は理由つきで知らせて止め、402は止めて知らせる。 */
export function subscribeEvents(onEvent: (type: string, data: Record<string, unknown>) => void, onNoContract: () => void = () => {}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let lastId = 0;
  (async () => {
    let backoff = 1000;
    while (!stopped) {
      try {
        controller = new AbortController();
        const response = await send("GET", "/events", { "accept-language": locale(), accept: "text/event-stream", ...(lastId ? { "last-event-id": String(lastId) } : {}) }, undefined, controller.signal);
        if (response.status === 401) {
          const code = errorBody(401, await response.json().catch(() => ({}))).code;
          if (code !== "time_off") { onUnauthorized(code); return; }
          throw new Error(code); // the clock: retried with the backoff below
        }
        // 契約が無い間は流れを張り直さない。契約の画面（S7）が出ていて、戻った時に main.tsx が張り直す。
        if (response.status === 402) { onNoContract(); return; }
        if (!response.ok || !response.body) throw new Error(String(response.status));
        backoff = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const id = /^id: ?(.*)$/m.exec(block)?.[1];
            const type = /^event: ?(.*)$/m.exec(block)?.[1];
            const data = /^data: ?(.*)$/m.exec(block)?.[1];
            if (id) lastId = Number(id);
            if (type) onEvent(type.trim(), data ? JSON.parse(data) : {});
          }
        }
      } catch {
        if (stopped) return;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  })();
  return () => { stopped = true; controller?.abort(); };
}
