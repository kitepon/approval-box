// peer-channel の server part（kitepon/peer-channel、vendor の tgz、無改造）を /pc/v1 に置く所。形は docs/architecture/peer-channel-adoption.md（c8b）。
// 使うのは公開の入口（@kitepon/peer-channel/server の createServerPart・SqliteMirrorStore）だけ。中身（K・通行証・鍵・封をした封筒）はログに出さない。
import { createServer, type IncomingMessage, type RequestListener, type ServerOptions } from "node:http";
import { randomBytes } from "node:crypto";
import { LoginBillingError } from "@kitepon/login-billing/server";
import { createServerPart, SqliteMirrorStore, type Identity, type ServerPart } from "@kitepon/peer-channel/server";
import type { Accounts } from "./accounts.ts";
import { ApiError } from "./errors.ts";
import type { Library } from "./lb.ts";

export type PeerChannelInput = {
  accounts: Accounts;
  library: Library;
  publicUrl: string;
  /** 登録の写し（公開鍵と署名だけ）の SQLite ファイル。本体の DB とは別。 */
  mirrorPath: string;
  /** その K の端末へ、中身の無い起こしの知らせ（push.ts Waker）。 */
  wake: (k: string, alert: boolean) => void | Promise<void>;
  /** TURN の設定がある時だけ。無ければ urls は空で答える（coturn はまだ無い）。 */
  turn?: { secret: string; urls: string[] };
};

/** Node の要求を、ライブラリの authenticate が読む Request にする。通行証は Authorization にあるので本文は渡さない。 */
function asRequest(req: IncomingMessage, publicUrl: string) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return new Request(`${publicUrl}${req.url ?? "/"}`, { method: req.method === "HEAD" ? "HEAD" : "GET", headers });
}

const bearer = (req: IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];

/**
 * 端末は共有ライブラリの通行証（Bearer）で、AI の接続（コネクタ）は接続トークンで入る（peer-channel 契約 6.1）。
 * 通行証でない（pass_invalid）時だけ接続トークンとして確かめる。どちらでもなければ null（401）、ライブラリが断った通行証はその名前で 403。
 */
export function authenticate(accounts: Accounts, library: Library, publicUrl: string) {
  return async (req: IncomingMessage): Promise<Identity | { refused: string } | null> => {
    try {
      const pass = await library.handler.authenticate(asRequest(req, publicUrl));
      return { k: pass.k, kind: "device", endpoint_ref: pass.passId, pass_kind: pass.kind };
    } catch (error) {
      if (!(error instanceof LoginBillingError)) throw error;
      if (error.code !== "pass_invalid") return { refused: error.code };
    }
    try {
      const conn = accounts.connectionByToken(bearer(req));
      return { k: conn.user_id, kind: "connector", endpoint_ref: conn.id };
    } catch (error) {
      if (error instanceof ApiError) return null;
      throw error;
    }
  };
}

/** server part と、それを /pc/v1 に置く HTTP サーバーの作り方（@hono/node-server の serve の createServer に渡す）。 */
export function createPeerChannel(input: PeerChannelInput) {
  const part: ServerPart = createServerPart({
    authenticate: authenticate(input.accounts, input.library, input.publicUrl),
    wake: input.wake,
    store: new SqliteMirrorStore(input.mirrorPath),
    // TURN が無いサーバーでも形は同じ（urls が空）。秘密はこの起動の間だけの乱数で、どこにも書かない。
    turn: input.turn ?? { secret: randomBytes(32).toString("base64url"), urls: [] },
    onError: () => { /* 中身の無い符号だけだが、今は数えない */ },
  });
  // ライブラリがログインを終えた時（停止・サインアウト・入れ替え・ほかをすべて停止）、その通行証が入れた枠をすぐ空ける（契約 4.5、0.4.10）。
  input.library.lb.onPassEnded((event) => part.onPassEnded(event));

  const mount = ((options: ServerOptions, listener: RequestListener) => {
    const server = createServer(options ?? {}, (req, res) => {
      if (!req.url?.startsWith("/pc/v1/")) return listener(req, res);
      part.handleRequest(req, res).then(
        (handled) => { if (!handled) listener(req, res); },
        () => { if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "internal" })); },
      );
    });
    // WebSocket は /pc/v1/signal だけ。ほかのアップグレードは今まで通り受けない。
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?")[0] !== "/pc/v1/signal") return socket.destroy();
      part.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });
    return server;
  }) as unknown as typeof createServer;

  return { part, createServer: mount };
}
export type PeerChannel = ReturnType<typeof createPeerChannel>;
