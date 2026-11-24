// peer-channel の server part（kitepon/peer-channel、vendor の tgz、無改造）を /pc/v1 に置く所。形は docs/architecture/peer-channel-adoption.md（c8b）。
// 使うのは公開の入口（@kitepon/peer-channel/server の createServerPart・SqliteMirrorStore）だけ。中身（K・通行証・鍵・封をした封筒）はログに出さない。
import { createServer, type IncomingMessage, type RequestListener, type ServerOptions } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { LoginBillingError } from "@kitepon/login-billing/server";
import { createServerPart, SqliteMirrorStore, type Identity, type ServerPart, type TurnAnswer } from "@kitepon/peer-channel/server";
import type { Accounts } from "./accounts.ts";
import { ApiError } from "./errors.ts";
import { type Library, PRODUCT_ID, rateLimiter } from "./lb.ts";
import { type AppKeyholes, KeyholeError, SIGNED_HEADER } from "./keyholes.ts";

export type PeerChannelInput = {
  accounts: Accounts;
  library: Library;
  publicUrl: string;
  /** 登録の写し（公開鍵と署名だけ）の SQLite ファイル。本体の DB とは別。 */
  mirrorPath: string;
  /** その K の端末へ、中身の無い起こしの知らせ（push.ts Waker）。 */
  wake: (k: string, alert: boolean) => void | Promise<void>;
  /** TURN の設定がある時だけ。coturn の共有の秘密か、Cloudflare TURN のような払い出し役。無ければ urls は空で答える。 */
  turn?: { secret: string; urls: string[] } | { generate(): Promise<TurnAnswer> };
  /** login-billing keyholes: a signed request is a device of entry E (local-form.md). */
  keyholes?: AppKeyholes;
};

/** Body cap of a /pc/v1 request, checked before the signature (Mint's t03 review): 64 KiB, the largest registry snapshot peer-channel allows (contract 4.5). */
const PC_BODY_MAX = 64 * 1024;
/** The caller as http.ts clientKey sees it: the last X-Forwarded-For hop, else the socket's peer. Memory only. */
const sourceOf = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)!.trim() || (req.socket?.remoteAddress ?? "");
/** Raw bodies of signed /pc/v1 requests, read once in the mount for the signature check (the part reads the copy). */
const signedBodies = new WeakMap<IncomingMessage, Uint8Array>();
const isSigned = (req: IncomingMessage) => req.headers[SIGNED_HEADER] !== undefined;

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
 * 契約が無い時（/v1 の G1・/connector/v1 の G2 と同じ判定）は入れるが、端末の join と接続の wait.open だけをその符号で断る（契約 10.2）。
 * 通行証が更新された時は、/v1 と同じく Login-Billing-Pass（cookie なら Set-Cookie）を /pc/v1 の HTTP の答えに付ける。
 */
export function authenticate(accounts: Accounts, library: Library, publicUrl: string, keyholes?: AppKeyholes) {
  const allowSigned = rateLimiter(240, 60_000);
  return async (req: IncomingMessage): Promise<Identity | { refused: string } | null> => {
    // The new form first: a signed request (the WebSocket GET is signed over an empty body). peer-channel answers only 401 or 403 + code, so every
    // refusal goes back as its code (time_off included); `now` of time_off is not carried. pass_kind "keyhole" is outside peer-channel 0.5.7's PassKind (t04).
    if (keyholes && isSigned(req)) {
      if (!allowSigned(sourceOf(req))) return { refused: "rate_limited" }; // before the signature check (the body cap is in the mount)
      try {
        const request = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: signedBodies.get(req) ?? new Uint8Array() };
        const who = await keyholes.entries.serial(async () => { const found = await keyholes.verify(request); keyholes.entries.signedIn(found.entry); return found; });
        return { k: who.entry, kind: "device", endpoint_ref: who.key, pass_kind: "keyhole" as Identity["pass_kind"] & string };
      } catch (error) {
        if (error instanceof KeyholeError) return { refused: error.code };
        throw error;
      }
    }
    try {
      const pass = await library.handler.authenticate(asRequest(req, publicUrl));
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of pass.headers) if (name !== "set-cookie") headers[name] = value;
      if (pass.headers.getSetCookie().length) headers["set-cookie"] = pass.headers.getSetCookie();
      const paid = pass.entitlements.some((e) => e.productId === PRODUCT_ID); // G1 と同じ（exempt の K もライブラリが権利として返す）
      return { k: pass.k, kind: "device", endpoint_ref: pass.passId, pass_kind: pass.kind, ...(paid ? {} : { not_entitled: "no_entitlement" }), response_headers: headers };
    } catch (error) {
      if (!(error instanceof LoginBillingError)) throw error;
      if (error.code !== "pass_invalid") return { refused: error.code };
    }
    try {
      const conn = accounts.connectionByToken(bearer(req));
      let notEntitled: string | undefined;
      try { accounts.assertCanUse(conn.user_id); } catch (error) { if (!(error instanceof ApiError)) throw error; notEntitled = error.code; } // G2: /connector/v1 が申請の前に見るのと同じ
      return { k: conn.user_id, kind: "connector", endpoint_ref: conn.id, ...(notEntitled ? { not_entitled: notEntitled } : {}) };
    } catch (error) {
      if (error instanceof ApiError) return null;
      throw error;
    }
  };
}

/**
 * Cloudflare Realtime TURN（家のルーターの転送なし）。端末の求めごとに、TURN 鍵の API トークンで短い期限の資格を払い出す。
 * 中継は DTLS のままの中身しか見ない。53番のURLは外す（ブラウザ以外でも時間切れの元）。鍵とトークンは記録に出さない。
 */
export function cloudflareTurn(keyId: string, apiToken: string, fetchFn: typeof fetch = fetch, ttl = 600): { generate(): Promise<TurnAnswer> } {
  return {
    async generate() {
      const r = await fetchFn(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`cloudflare_turn_${r.status}`);
      const servers = ((await r.json()) as { iceServers?: { urls?: string[] | string; username?: string; credential?: string }[] }).iceServers ?? [];
      const turn = servers.find((e) => e.username && e.credential);
      if (!turn) throw new Error("cloudflare_turn_shape");
      const urls = servers.flatMap((e) => (Array.isArray(e.urls) ? e.urls : e.urls ? [e.urls] : [])).filter((u) => !/:53(\?|$)/.test(u));
      return { urls, username: turn.username!, credential: turn.credential!, ttl };
    },
  };
}

/** The body of a signed request as a fresh stream with the same url, method and headers; null when over the part's own cap. */
async function readSigned(req: IncomingMessage): Promise<IncomingMessage | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > PC_BODY_MAX) return null;
    parts.push(chunk);
  }
  const body = Buffer.concat(parts);
  const copy = Object.assign(Readable.from(body.length ? [body] : []), { url: req.url, method: req.method, headers: req.headers, socket: req.socket }) as unknown as IncomingMessage;
  signedBodies.set(copy, new Uint8Array(body));
  return copy;
}

/** server part と、それを /pc/v1 に置く HTTP サーバーの作り方（@hono/node-server の serve の createServer に渡す）。 */
export function createPeerChannel(input: PeerChannelInput) {
  const part: ServerPart = createServerPart({
    authenticate: authenticate(input.accounts, input.library, input.publicUrl, input.keyholes),
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
      // A signed request: read its body once (the signature covers it) and hand the part a copy to read again.
      const ready = input.keyholes && isSigned(req) ? readSigned(req) : Promise.resolve(req);
      ready.then((r) => r ? part.handleRequest(r, res) : (res.writeHead(413, { "content-type": "application/json" }), res.end(JSON.stringify({ error: "too_large" })), true)).then(
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
