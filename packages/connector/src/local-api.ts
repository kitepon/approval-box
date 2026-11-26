// peer-channel の道（c8c）で、MCPの道具がデーモンの LocalBox を呼ぶ所。Api と同じ call(method, path, body) の形で、
// 1行のJSONをデーモンのローカルソケット（Windowsは名前付きパイプ）へ送り、1行の答えを読む。本文はこの端末から出ない。
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { ServerError } from "./api.ts";
import { renameWithRetry } from "./config.ts";
import { provenDoor } from "./door.ts";
import type { LocalBox } from "./local-box.ts";
import { stateRoot } from "./profile.ts";

/** Windows のパイプ名: 状態の置き場のハッシュだけでは別のアカウントが導けるので、pc/pipe-id の乱数も入れる（SEC-087）。 */
export const pipeName = (root: string, id: string) => `\\\\.\\pipe\\approval-box-${createHash("sha256").update(root).digest("hex").slice(0, 16)}-${id}`;

const pipeIdFile = (root: string) => join(root, "pc", "pipe-id");

/** pc/pipe-id（乱数16バイトの16進、0600）。create が真なら無い時に作る（デーモンだけ）。読むだけで無ければ undefined。 */
export function pipeId(root: string, { create = false } = {}): string | undefined {
  const file = pipeIdFile(root);
  try { const text = readFileSync(file, "utf8").trim(); if (/^[0-9a-f]{32}$/.test(text)) return text; } catch { /* 無い */ }
  if (!create) return undefined;
  const id = randomBytes(16).toString("hex");
  mkdirSync(join(root, "pc"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${id}\n`, { mode: 0o600 });
  renameWithRetry(temp, file);
  return id;
}

/**
 * デーモンの入口。Unix は state/pc/daemon.sock。Windows は pipeName(root, pipeId)。
 * create はデーモンだけが真にする。クライアントで id が無い時は、誰も開けない乱数の名前にする（今のパイプ無しと同じ ENOENT になり、他人が置いた名前へはつながない）。
 */
export const socketPath = (root = stateRoot(), create = false) => process.platform === "win32"
  ? pipeName(root, pipeId(root, { create }) ?? randomBytes(16).toString("hex"))
  : join(root, "pc", "daemon.sock");

type Reply = { ok: true; result: unknown } | { ok: false; status: number; code: string; message: string; body: Record<string, unknown> };

/** デーモンの今の状態（GET /status、c8h）。秘密もIDの中身も載せない。 */
export type DaemonStatusReply = { schema: "approval-box.daemon-status.v1"; mode: "pc" | "not_paired" | "starting"; paired: boolean; reason: string; connection_id?: string; server?: string; version: string; pid: number };

/**
 * デーモン側: LocalBox の経路を、ソケット越しに答える。`GET /status` は status() が答える。
 * box が無い間（--hosted で、まだつながっていない・起動中）は、申請の経路に 503 と status の reason の名前で答える（今の道へ黙って回さない）。
 */
// 申請画像は1枚20MiB（base64で約27MiB）。1行をこの上限まで受ける。
const MAX_LINE = 32 * 1024 * 1024;
const ATTACHMENT = /^\/decisions\/[^/]+\/attachments\/[^/?]+$/;

// shortcut: ソケットは呼び手を確かめない。開ける人は誰でもこのアカウントの申請を読める（今の席の共有 ~/.approval-box と同じ信頼）。誰が開けるかは置き場の権限と監督役（BellTeam）が決める。席ごとに分ける時に呼び手の印を足す。
export function serveLocal(box: Pick<LocalBox, "route" | "download" | "stageUpload"> | null, path = socketPath(stateRoot(), true), status?: () => DaemonStatusReply): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) return socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: Reply;
      try {
        const { method, path: route, body } = JSON.parse(buffer.slice(0, end)) as { method: string; path: string; body?: unknown };
        if (method === "GET" && route === "/status" && status) reply = { ok: true, result: status() };
        else if (!box) { const st = status?.(); throw new ServerError(503, st?.mode === "starting" ? "starting" : "not_paired", `Approval Box の接続はまだ使えません（${st?.reason ?? "not_paired"}）。`, {}); }
        else if (method === "GET" && ATTACHMENT.test(route)) reply = { ok: true, result: { data: box.download(route).toString("base64") } };
        else if (method === "POST" && route === "/uploads") {
          const b = (body ?? {}) as { name?: unknown; content_type?: unknown; data?: unknown };
          if (typeof b.name !== "string" || typeof b.content_type !== "string" || typeof b.data !== "string") throw new ServerError(400, "validation_failed", "申請画像の形が正しくありません。", {});
          reply = { ok: true, result: box.stageUpload(Buffer.from(b.data, "base64"), b.name, b.content_type) };
        }
        else reply = { ok: true, result: box.route(method, route, body) };
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
  private readonly resolve?: () => Promise<string>;

  /** resolve: where to connect for each call (the use-hosted door on Windows proves itself first, door.ts); default this.path. */
  constructor(path = socketPath(), waitMs = 10_000, resolve?: () => Promise<string>) {
    this.path = path;
    this.waitMs = waitMs;
    this.resolve = resolve;
  }

  private async once(method: string, route: string, body?: unknown): Promise<Reply> {
    const path = this.resolve ? await this.resolve() : this.path;
    return new Promise((ok, fail) => {
      const socket = createConnection(path);
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
        if (error instanceof ServerError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === "ENOENT" || code === "ECONNREFUSED") && Date.now() < until) { await sleep(200); continue; }
        throw new ServerError(0, "daemon_unreachable", `Approval Boxの配送デーモンにつながりません（${code ?? (error as Error).message}）。少し待ってからやり直してください。`, {});
      }
      if (reply.ok) return reply.result as T;
      throw new ServerError(reply.status, reply.code, reply.message, reply.body);
    }
  }

  /** 添付の中身。ソケットで受け取る（デーモンが別の利用者でも読める、a514n）。 */
  async download(path: string): Promise<Buffer> {
    return Buffer.from((await this.call<{ data: string }>("GET", path)).data, "base64");
  }

  /** 申請画像をデーモンへ渡し、その印を返す。デーモンが state/pc/uploads に置き、申請の時に端末へ運ぶ（サーバーへは送らない）。 */
  async uploadRequestImage(data: Buffer, name: string, contentType: string): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", "/uploads", { name, content_type: contentType, data: data.toString("base64") });
  }

  /** use-hosted の席の入口。Windows では入口の名前を信じず、名乗りを確かめてから送る（door.ts）。POSIX は 0700 の中の 0600 のソケット。 */
  static hosted(socket: string, platform = process.platform) {
    return new LocalApi(socket, undefined, platform === "win32" ? () => provenDoor(socket) : undefined);
  }

  /** 席のデーモン（use-hosted）の受信: ソケットには知らせが無いので、2秒ごとに onEvent を呼び、配送待ちを読み直させる。 */
  async stream(onEvent: (event: string) => void, signal: AbortSignal) {
    while (!signal.aborted) { onEvent("deliveries"); await sleep(2000); }
  }
}
