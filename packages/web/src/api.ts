import type { ApiErrorBody } from "./types";

const SESSION_KEY = "kessaibako.session";

export function getSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
export function setSession(session: string | null) {
  try { session ? localStorage.setItem(SESSION_KEY, session) : localStorage.removeItem(SESSION_KEY); } catch { /* 保存できなくても今回は使える */ }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T>(method: string, path: string, body?: unknown, options: { idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const session = getSession();
  if (session) headers.authorization = `Bearer ${session}`;
  if (options.idempotent ?? method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
  const key = headers["idempotency-key"];
  // 書き込みは通信が切れたら同じ冪等キーで1回だけ送り直す（二重に答えない）。
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`/v1${path}`, { method, headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      if (attempt === 0 && key) continue;
      throw new ApiError(0, { code: "network", message: "サーバーにつながりません。通信を確かめてください。" });
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (response.ok) return json as T;
    const err = (json.error ?? { code: "internal", message: `HTTP ${response.status}` }) as ApiErrorBody;
    if (response.status === 401) { setSession(null); onUnauthorized(); }
    if (response.status >= 500 && attempt === 0 && key) continue;
    throw new ApiError(response.status, err);
  }
}

/** /v1/events を読む。EventSourceはヘッダーを付けられないので fetch で読む。切れたら間隔を延ばして張り直す。 */
export function subscribeEvents(onEvent: (type: string, data: Record<string, unknown>) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let lastId = 0;
  (async () => {
    let backoff = 1000;
    while (!stopped) {
      try {
        controller = new AbortController();
        const response = await fetch("/v1/events", {
          headers: { authorization: `Bearer ${getSession() ?? ""}`, accept: "text/event-stream", ...(lastId ? { "last-event-id": String(lastId) } : {}) },
          signal: controller.signal,
        });
        if (response.status === 401) { setSession(null); onUnauthorized(); return; }
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
