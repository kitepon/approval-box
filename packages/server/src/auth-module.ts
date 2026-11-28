// 認証モジュール（unix ソケット）へ署名を頼む。鍵はモジュールだけが持ち、サーバーは受け取らない。
// 1接続につき JSON を1行送り、1行の返事を受けて、モジュールが閉じる。呼び元はソケットが決める（cwd は送らない）。
// 例外は http-stream（moduleFetch）で、1行の返事のあとに [tag 1B][長さ 4B big-endian][data] の枠が続く。
import { connect } from "node:net";
import { createPrivateKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** 署名するバイト列 -> 署名。ES256 は r||s の 64 バイト（IEEE P1363）、RS256 は PKCS#1 v1.5 + SHA-256。 */
export type Signer = (data: Buffer) => Promise<Buffer>;
export type ModuleRequest = { op: string; name: string; [field: string]: unknown };
export type ModuleReply = { outcome: string; data?: string; error?: string };

const TIMEOUT_MS = 15_000;
const MAX_REPLY = 1024 * 1024;
const MAX_SIGN_INPUT = 3072;

/** 1行の要求を送り、1行の返事を読む。失敗の Error は理由の種類だけを持ち、要求の中身や鍵は入れない。 */
export function ask(socketPath: string, request: ModuleRequest): Promise<ModuleReply> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: Error | undefined, reply?: ModuleReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    const parse = () => {
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as unknown;
        if (!reply || typeof reply !== "object" || typeof (reply as ModuleReply).outcome !== "string") throw new Error("shape");
        finish(undefined, reply as ModuleReply);
      } catch {
        finish(new Error("bad reply"));
      }
    };
    const socket = connect(socketPath);
    const timer = setTimeout(() => finish(new Error("timeout")), TIMEOUT_MS);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPLY) return finish(new Error("reply too large"));
      chunks.push(chunk);
      if (chunk.includes(10)) parse();
    });
    socket.on("end", () => { if (!done) chunks.length ? parse() : finish(new Error("no reply")); });
    socket.on("error", (error: NodeJS.ErrnoException) => finish(new Error(`unreachable${error.code ? ` ${error.code}` : ""}`)));
  });
}

/** モジュールの item で署名する。Error の文は item と結果（outcome）だけで、データも鍵も入れない。 */
export function moduleSigner(socketPath: string, item: string): Signer {
  return async (data) => {
    if (data.length > MAX_SIGN_INPUT) throw new Error(`auth module ${item}: input too large`);
    let reply: ModuleReply;
    try {
      reply = await ask(socketPath, { op: "sign", name: item, data: data.toString("base64") });
    } catch (error) {
      throw new Error(`auth module ${item}: ${(error as Error).message}`);
    }
    if (reply.outcome !== "granted" || typeof reply.data !== "string" || !reply.data) throw new Error(`auth module ${item}: ${reply.outcome === "granted" ? "no signature" : reply.outcome}`);
    return Buffer.from(reply.data, "base64");
  };
}

/** 環境の鍵で署名する（認証モジュールを使わない形）。鍵は署名の時に読むので、読めない鍵は署名の失敗として現れる。 */
export function keySigner(key: string | KeyObject, alg: "ES256" | "RS256"): Signer {
  return async (data) => alg === "ES256" ? sign("sha256", data, { key: typeof key === "string" ? createPrivateKey(key) : key, dsaEncoding: "ieee-p1363" }) : sign("RSA-SHA256", data, key);
}

// --- http-stream: モジュールが bearer を付けて相手先（item の base）へ HTTP を話す。サーバーは Authorization を持たない。 ---
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// モジュールが通すヘッダー（それ以外は捨てられる）。authorization は送らない。
const STREAM_HEADERS = new Set(["accept", "content-type", "x-call-bridge-caller-id", "mcp-session-id", "mcp-protocol-version", "last-event-id", "mcp-method", "mcp-name"]);
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const MAX_STREAMS = 2; // モジュール全体で同時8本。この道は2本までしか開かない（POST の SSE と GET の SSE）
const HEADERS_TIMEOUT_MS = 60_000;
const MAX_FRAME = 16 * 1024 * 1024;

/**
 * モジュールの item へ http-stream で話す fetch。Request（または URL + init）を1本のソケットにして、Response（status・headers・本文の流れ）を返す。
 * 本文は枠が届くたびに流し、終了コードが "0" でなければ本文の途中の失敗にする。signal・cancel・終了のどれでもソケットを閉じる（上流も止まる）。
 * Error の文は item と結果だけで、ヘッダーも本文も入れない。
 */
export function moduleFetch(socketPath: string, item: string): FetchLike {
  let open = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) if (STREAM_HEADERS.has(name.toLowerCase())) headers[name] = value;
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (open >= MAX_STREAMS) throw new Error(`auth module ${item}: too many open streams`);
    open++;
    return new Promise<Response>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0);
      let granted = false; // 先頭の1行を受けたか
      let head = false; // tag 5 を受けて Response を渡したか
      let finished = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const socket = connect(socketPath);
      const end = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        open--;
        socket.destroy();
        if (!head) reject(error ?? new Error(`auth module ${item}: no reply`));
        else try { if (error) controller?.error(error); else controller?.close(); } catch { /* the reader already cancelled */ }
      };
      const fail = (reason: string) => end(new Error(`auth module ${item}: ${reason}`));
      const onAbort = () => end(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted"));
      const timer = setTimeout(() => fail("timeout"), HEADERS_TIMEOUT_MS);
      if (request.signal.aborted) return onAbort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      const frame = (tag: number, data: Buffer) => {
        if (tag === 5) {
          if (head) return fail("duplicate head");
          let meta: { status?: unknown; headers?: Record<string, unknown> };
          try { meta = JSON.parse(data.toString("utf8")) as typeof meta; } catch { return fail("bad head"); }
          const status = Number(meta.status);
          if (!Number.isInteger(status) || status < 200 || status > 599) return fail("bad status");
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(meta.headers ?? {})) {
            try { responseHeaders.append(name, Array.isArray(value) ? value.join(", ") : String(value)); } catch { /* shortcut: a header name or value fetch rejects is dropped; fine while only mcp-* and content-type are read */ }
          }
          clearTimeout(timer);
          head = true;
          // shortcut: no backpressure (chunks queue as they come); fine for the small MCP answers, upgrade if a large body is ever carried.
          const stream = NO_BODY_STATUS.has(status) ? null : new ReadableStream<Uint8Array>({
            start: (c) => { controller = c; },
            cancel: () => end(),
          });
          resolve(new Response(stream, { status, headers: responseHeaders }));
          if (!stream) end();
        } else if (tag === 1) {
          if (head) controller?.enqueue(new Uint8Array(data));
        } else if (tag === 3) {
          const code = data.toString("utf8").trim();
          if (code === "0" && head) end(); else fail(code === "0" ? "ended before the head" : `stream cut (${code})`);
        } // tag 4 はハートビート。無視する
      };
      const parse = () => {
        if (!granted) {
          const at = buffer.indexOf(10);
          if (at < 0) return buffer.length > MAX_FRAME ? fail("reply too large") : undefined;
          let reply: ModuleReply;
          try {
            reply = JSON.parse(buffer.subarray(0, at).toString("utf8")) as ModuleReply;
            if (!reply || typeof reply.outcome !== "string") throw new Error("shape");
          } catch { return fail("bad reply"); }
          if (reply.outcome !== "granted") return fail(reply.outcome);
          granted = true;
          buffer = buffer.subarray(at + 1);
        }
        while (!finished && buffer.length >= 5) {
          const length = buffer.readUInt32BE(1);
          if (length > MAX_FRAME) return fail("frame too large");
          if (buffer.length < 5 + length) return;
          const tag = buffer[0]!;
          const data = buffer.subarray(5, 5 + length);
          buffer = buffer.subarray(5 + length);
          frame(tag, data);
        }
      };
      socket.on("connect", () => socket.write(`${JSON.stringify({ op: "http-stream", name: item, method: request.method, path: url.pathname + url.search, headers, ...(body?.length ? { body: body.toString("base64") } : {}) })}\n`));
      socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
      socket.on("end", () => fail(head ? "stream cut (closed)" : "no reply"));
      socket.on("error", (error: NodeJS.ErrnoException) => fail(`unreachable${error.code ? ` ${error.code}` : ""}`));
    });
  };
}
