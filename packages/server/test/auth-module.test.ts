// 認証モジュール（unix ソケット）の署名。モジュールの代役を一時のソケットに立てて確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Apns } from "../src/push.ts";
import { GoogleToken } from "../src/google-auth.ts";
import { adminAuthorized } from "../src/diagnostics.ts";
import { ask, keySigner, moduleSigner } from "../src/auth-module.ts";

const es = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const posix = { skip: process.platform === "win32" ? "unix ソケットは Linux だけ" : false };

/** 1行の要求を読み、items の鍵で署名して1行を返して閉じる代役。seen に要求を残す。 */
async function fakeModule(reply?: (request: Record<string, unknown>) => Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ab-auth-module-"));
  const path = join(dir, "approval-box.sock");
  const seen: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer) as Record<string, unknown>;
      seen.push(request);
      const bytes = Buffer.from(String(request.data), "base64");
      const answer = reply ? reply(request) : request.name === "apns"
        ? { outcome: "granted", data: sign("sha256", bytes, { key: es.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64") }
        : request.name === "play" ? { outcome: "granted", data: sign("RSA-SHA256", bytes, rsa.privateKey).toString("base64") }
        : { outcome: "not-registered", error: "secret-looking detail" };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, seen, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("moduleSigner: ES256 の署名は r||s の 64 バイトで、Apns の JWT が公開鍵で確かめられる", posix, async () => {
  const mod = await fakeModule();
  try {
    const apns = new Apns({ sign: moduleSigner(mod.path, "apns"), keyId: "KID", teamId: "TEAM", topic: "t" });
    const jwt = await (apns as unknown as { token(): Promise<string> }).token();
    const [h, c, s] = jwt.split(".");
    assert.equal(Buffer.from(s!, "base64url").length, 64);
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: es.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));
    assert.deepEqual(mod.seen[0] && { op: mod.seen[0].op, name: mod.seen[0].name, cwd: mod.seen[0].cwd }, { op: "sign", name: "apns", cwd: undefined });
    await (apns as unknown as { token(): Promise<string> }).token();
    assert.equal(mod.seen.length, 1, "50分は同じ JWT を使い回す");
  } finally { mod.close(); }
});

test("moduleSigner: RS256 の署名で、Google の assertion が公開鍵で確かめられる", posix, async () => {
  const mod = await fakeModule();
  try {
    let assertion = "";
    const fake = (async (_url: string, init: RequestInit) => {
      assertion = String(new URLSearchParams(String(init.body)).get("assertion"));
      return new Response(JSON.stringify({ access_token: "ya29", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const token = new GoogleToken({ client_email: "s@x.iam.gserviceaccount.com", sign: moduleSigner(mod.path, "play") }, "scope", () => fake);
    assert.equal(await token.get(), "ya29");
    const [h, c, s] = assertion.split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s!, "base64url")));
  } finally { mod.close(); }
});

test("moduleSigner: denied などは item と outcome だけの Error になり、データも module の error 文も入らない", posix, async () => {
  const mod = await fakeModule((request) => ({ outcome: "denied", error: `detail ${String(request.data)}` }));
  try {
    const data = Buffer.from("payload-that-must-not-leak");
    await assert.rejects(() => moduleSigner(mod.path, "apns")(data), (error: Error) => {
      assert.equal(error.message, "auth module apns: denied");
      return true;
    });
    // 届かないソケットも、名前と理由だけ。
    await assert.rejects(() => moduleSigner(join(tmpdir(), "no-such-auth-module.sock"), "play")(data), (error: Error) => /^auth module play: unreachable/.test(error.message) && !error.message.includes(data.toString("base64")));
    await assert.rejects(() => moduleSigner(mod.path, "apns")(Buffer.alloc(3073)), /input too large/);
  } finally { mod.close(); }
});

test("Apns: モジュールが denied なら、送信は status 0 の理由つきで返り、例外にならない", posix, async () => {
  const mod = await fakeModule(() => ({ outcome: "denied" }));
  try {
    const apns = new Apns({ sign: moduleSigner(mod.path, "apns"), keyId: "KID", teamId: "TEAM", topic: "t" });
    assert.deepEqual(await apns.send("sandbox", "tok", {}, {}), { status: 0, reason: "sign auth module apns: denied" });
  } finally { mod.close(); }
});

test("ask: 返事が大きすぎる時は失敗する", posix, async () => {
  const big = await fakeModule(() => ({ outcome: "granted", data: "A".repeat(1024 * 1024 + 10) }));
  try {
    await assert.rejects(() => ask(big.path, { op: "sign", name: "apns", data: "" }), /reply too large/);
  } finally { big.close(); }
});

test("keySigner: ES256 は P1363、RS256 は PKCS#1 v1.5 で、環境の鍵でも同じ署名の形になる", async () => {
  const data = Buffer.from("a.b");
  const e = await keySigner(es.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "ES256")(data);
  assert.equal(e.length, 64);
  assert.ok(verify("sha256", data, { key: es.publicKey, dsaEncoding: "ieee-p1363" }, e));
  assert.ok(verify("RSA-SHA256", data, rsa.publicKey, await keySigner(rsa.privateKey, "RS256")(data)));
});

test("管理の鍵: SHA-256 だけでも通り、違う鍵・形の違う SHA-256 は通らない。生の鍵も今まで通り", () => {
  const token = "ab".repeat(32);
  const sha = createHash("sha256").update(token).digest("hex");
  assert.equal(adminAuthorized(`Bearer ${token}`, undefined, sha), true);
  assert.equal(adminAuthorized(`Bearer ${token}`, undefined, sha.toUpperCase()), true);
  assert.equal(adminAuthorized("Bearer other", undefined, sha), false);
  assert.equal(adminAuthorized(token, undefined, sha), false);
  assert.equal(adminAuthorized(`Bearer ${token}`, undefined, "abc"), false);
  assert.equal(adminAuthorized(`Bearer ${token}`), false);
  assert.equal(adminAuthorized(`Bearer ${token}`, token), true);
  assert.equal(adminAuthorized("Bearer ", ""), false);
  assert.equal(adminAuthorized(`Bearer ${token}`, "wrong", sha), true);
});
