import type { Config } from "./config.ts";

export class ServerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Approval Boxサーバーのコネクタ用API（/connector/v1）。 */
export class Api {
  readonly server: string;
  private readonly token: string | undefined;

  constructor(config: Pick<Config, "server" | "token">) {
    this.server = config.server.replace(/\/$/, "");
    this.token = config.token;
  }

  url(path: string) {
    return `${this.server}/connector/v1${path}`;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ServerError(0, "network", `Approval Boxサーバー（${this.server}）につながりません: ${(error as Error).message}`, {});
    }
    const text = await response.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // 前段（Cloudflare・リバースプロキシ）のエラーページなど、サーバーのJSONでない応答。
      // 要求がサーバーまで届いたかは分からない。書き込みなら「作られた／作られていない」と言い切らず、一覧で確かめさせる。
      const contentType = response.headers.get("content-type") ?? "";
      const head = `Approval Boxサーバーから、JSONでない応答が返りました（HTTP ${response.status}、Content-Type: ${contentType || "なし"}）。前段（Cloudflareなど）のエラーページで、サーバーが一時的に止まっていた可能性があります。`;
      const tail = method === "GET"
        ? "少し待ってから、同じ操作をやり直してください。"
        : "この操作がサーバーで行われたかは分かりません。やり直す前に list_my_decisions で確かめてください。申請なら、一覧に無ければ出し直し、あればそれを使ってください。";
      throw new ServerError(response.status, "non_json_response", `${head}${tail}`, { http_status: response.status, content_type: contentType, outcome: method === "GET" ? "not_applied" : "unknown" });
    }
    if (!response.ok) {
      const error = (json.error ?? {}) as { code?: string; message?: string };
      throw new ServerError(response.status, error.code ?? "internal", error.message ?? `HTTP ${response.status}`, error as Record<string, unknown>);
    }
    return json as T;
  }

  /** コネクタ用SSE。届いたイベント名ごとに onEvent を呼ぶ。切れたら戻る。 */
  async stream(onEvent: (event: string) => void, signal: AbortSignal) {
    const response = await fetch(this.url("/stream"), { headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) throw new ServerError(response.status, "stream", `受信の接続に失敗しました（HTTP ${response.status}）`, {});
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const name = /^event: ?(.*)$/m.exec(block)?.[1];
        if (name) onEvent(name.trim());
      }
    }
  }
}
