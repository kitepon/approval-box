// 認証モジュール（unix ソケット）へ署名を頼む。鍵はモジュールだけが持ち、サーバーは受け取らない。
// 1接続につき JSON を1行送り、1行の返事を受けて、モジュールが閉じる。呼び元はソケットが決める（cwd は送らない）。
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
