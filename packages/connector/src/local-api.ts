// peer-channel の道（c8c）で、MCPの道具がデーモンの LocalBox を呼ぶ所。Api と同じ call(method, path, body) の形で、
// 1行のJSONをデーモンのローカルソケット（Windowsは名前付きパイプ）へ送り、1行の答えを読む。本文はこの端末から出ない。
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pcRoot } from "./pc-mode.ts";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { ServerError } from "./api.ts";
import { LocalBox } from "./local-box.ts";
import { stateRoot } from "./profile.ts";

export const socketPath = (root = stateRoot()) => process.platform === "win32"
  ? `\\\\.\\pipe\\approval-box-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
  : join(root, "pc", "daemon.sock");

type Reply = { ok: true; result: unknown } | { ok: false; status: number; code: string; message: string; body: Record<string, unknown> };

/** デーモン側: LocalBox の経路を、ソケット越しに答える。 */
export function serveLocal(box: LocalBox, path = socketPath()): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) return socket.destroy(); // 申請1件の上限（本文20,000字）より十分大きい
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: Reply;
      try {
        const { method, path: route, body } = JSON.parse(buffer.slice(0, end)) as { method: string; path: string; body?: unknown };
        reply = { ok: true, result: box.route(method, route, body) };
      } catch (error) {
        const e = error instanceof ServerError ? error : new ServerError(500, "internal", (error as Error).message, {});
        reply = { ok: false, status: e.status, code: e.code, message: e.message, body: e.body };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => socket.destroy());
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(path, () => ok(server));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** MCP側: Api と同じ形で、デーモンの LocalBox を呼ぶ。デーモンが起きる間（10秒まで）は待つ。 */
export class LocalApi {
  private readonly path: string;
  private readonly waitMs: number;

  constructor(path = socketPath(), waitMs = 10_000) {
    this.path = path;
    this.waitMs = waitMs;
  }

  private once(method: string, route: string, body?: unknown): Promise<Reply> {
    return new Promise((ok, fail) => {
      const socket = createConnection(this.path);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ method, path: route, body })}\n`));
      socket.on("data", (chunk: string) => { text += chunk; });
      socket.on("end", () => { try { ok(JSON.parse(text) as Reply); } catch { fail(new Error("デーモンの答えが読めません")); } });
      socket.on("error", fail);
    });
  }

  async call<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> {
    const until = Date.now() + this.waitMs;
    for (;;) {
      let reply: Reply;
      try { reply = await this.once(method, route, body); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === "ENOENT" || code === "ECONNREFUSED") && Date.now() < until) { await sleep(200); continue; }
        throw new ServerError(0, "daemon_unreachable", `Approval Boxの配送デーモンにつながりません（${code ?? (error as Error).message}）。少し待ってからやり直してください。`, {});
      }
      if (reply.ok) return reply.result as T;
      throw new ServerError(reply.status, reply.code, reply.message, reply.body);
    }
  }

  /** 添付の中身。同じ端末・同じ利用者のデーモンが書いた 0600 のファイルを、ソケットを通さず読む（大きな画像を1行のJSONに載せない）。 */
  async download(path: string): Promise<Buffer> {
    return new LocalBox(join(pcRoot(), "decisions.json")).download(path);
  }

  /** 申請画像を state/pc/uploads に 0600 で置き、その印を返す。申請の時にデーモンが受け取って端末へ運ぶ（サーバーへは送らない）。 */
  async uploadRequestImage(data: Buffer, name: string, contentType: string): Promise<{ id: string }> {
    const id = randomUUID();
    const dir = join(pcRoot(), "uploads");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, id), data, { mode: 0o600 });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ name, content_type: contentType }), { mode: 0o600 });
    return { id };
  }
}
