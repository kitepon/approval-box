import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Accounts } from "../src/accounts.ts";
import { all, get, openDb, run } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { resetKeyCache } from "../src/oidc.ts";

const APPLE_ID = "dev.kitepon.approvalbox.web";
const GOOGLE_ID = "g-web-client";

function fixture(webLogin: { apple_services_id?: string; google_client_id?: string } = { apple_services_id: APPLE_ID, google_client_id: GOOGLE_ID }) {
  resetKeyCache();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "d1", alg: "RS256" };
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "off");
  const app = createApp({ db, accounts, decisions: new Decisions(db, events), events, publicUrl: "https://kb.test", webLogin, idKeys: async () => [jwk as never] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const idToken = (provider: "apple" | "google", nonce: string, sub: string) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const iss = provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com";
    const aud = provider === "apple" ? APPLE_ID : GOOGLE_ID;
    const head = `${enc({ alg: "RS256", kid: "d1" })}.${enc({ iss, aud, exp: Math.floor(Date.now() / 1000) + 600, sub, nonce, email: `${sub}@example.test` })}`;
    return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
  };
  const start = async (provider: "apple" | "google", extra: Record<string, unknown> = {}) => {
    const res = await app.request(`/v1/auth/${provider}/web/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256", ...extra }) });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const callback = async (provider: "apple" | "google", fields: Record<string, string>) => {
    const res = await app.request(`/auth/${provider}/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    assert.equal(res.status, 303);
    return new URL(res.headers.get("location")!);
  };
  const link = (code: string, code_verifier = verifier) => app.request("/v1/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier }) });
  return { db, accounts, app, verifier, challenge, idToken, start, callback, link };
}

const nonceOf = (authorizationUrl: string) => new URL(authorizationUrl).searchParams.get("nonce")!;

test("redirect_uri を送らないAppleは、今までどおり approvalbox://auth/apple へ戻る", async () => {
  const x = fixture();
  const started = await x.start("apple");
  assert.equal(started.status, 200);
  assert.equal(get<{ redirect_uri: string | null }>(x.db, "select redirect_uri from auth_flows where state=?", started.json.state)?.redirect_uri, null);
  const back = await x.callback("apple", { state: started.json.state, id_token: x.idToken("apple", nonceOf(started.json.authorization_url), "apple-d1") });
  assert.equal(back.protocol, "approvalbox:");
  assert.equal(`${back.host}${back.pathname}`, "auth/apple");
  assert.equal(back.searchParams.get("state"), started.json.state);
  assert.equal((await x.link(back.searchParams.get("code")!)).status, 200);
});

test("redirect_uri を送らないGoogleは approvalbox://auth/google へ戻り、認可URLは指定どおり", async () => {
  const x = fixture();
  const started = await x.start("google");
  assert.equal(started.status, 200);
  const auth = new URL(started.json.authorization_url);
  assert.equal(`${auth.origin}${auth.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(auth.searchParams), {
    client_id: GOOGLE_ID, redirect_uri: "https://kb.test/auth/google/callback", response_type: "id_token", response_mode: "form_post",
    scope: "openid email", state: started.json.state, nonce: auth.searchParams.get("nonce"), prompt: "select_account",
  });
  assert.ok(auth.searchParams.get("nonce"));
  assert.ok(started.json.expires_at);
  const back = await x.callback("google", { state: started.json.state, id_token: x.idToken("google", nonceOf(started.json.authorization_url), "google-d1") });
  assert.equal(back.protocol, "approvalbox:");
  assert.equal(`${back.host}${back.pathname}`, "auth/google");
  assert.equal(back.searchParams.get("state"), started.json.state);
  const linked = await x.link(back.searchParams.get("code")!);
  assert.equal(linked.status, 200);
  const { session } = await linked.json() as { session: string };
  const me = await x.app.request("/v1/me", { headers: { authorization: `Bearer ${session}` } });
  assert.equal(((await me.json()) as { login: string }).login, "google");
});

for (const [provider, loopback, expected] of [
  ["apple", "http://127.0.0.1:48123/cb", "http://127.0.0.1:48123/cb"],
  ["apple", "http://[::1]:48123/cb", "http://[::1]:48123/cb"],
  ["google", "http://127.0.0.1:1024/", "http://127.0.0.1:1024/"],
  ["google", "http://[::1]:65535", "http://[::1]:65535/"],
] as const) {
  test(`${provider}: ループバック ${loopback} へ code と state を付けて戻り、verifier と合う時だけ session に替わる`, async () => {
    const x = fixture();
    const started = await x.start(provider, { redirect_uri: loopback });
    assert.equal(started.status, 200);
    const auth = new URL(started.json.authorization_url);
    // 提供元に渡す redirect_uri は、今までどおりサーバーのcallback（ループバックは載らない）
    assert.equal(auth.searchParams.get("redirect_uri"), `https://kb.test/auth/${provider}/callback`);
    assert.ok(![...auth.searchParams.values()].some((v) => v.includes("127.0.0.1") || v.includes("[::1]")));
    const back = await x.callback(provider, { state: started.json.state, id_token: x.idToken(provider, nonceOf(started.json.authorization_url), `${provider}-loop`) });
    assert.equal(`${back.origin}${back.pathname}`, expected.replace(/\/$/, "") + (expected.endsWith("/") ? "/" : ""));
    assert.equal(back.searchParams.get("state"), started.json.state);
    assert.equal(back.searchParams.get("error"), null);
    const code = back.searchParams.get("code")!;
    assert.equal((await x.link(code, randomBytes(32).toString("base64url"))).status, 401);
    // 使い損ねた verifier の試行でコードは消えない（今までの /v1/auth/link と同じ）。正しい verifier で一度だけ使える
    assert.equal((await x.link(code)).status, 200);
    assert.equal((await x.link(code)).status, 401);
  });
}

test("拒否する redirect_uri は、開始の時点で400 validation_failed になり、flowも作られない", async () => {
  const x = fixture();
  const bad = [
    "http://localhost:48123/cb", "http://192.168.1.5:48123/cb", "https://127.0.0.1:48123/cb", "http://127.0.0.1/cb", "http://127.0.0.1:80/cb",
    "http://127.0.0.1:1023/cb", "http://127.0.0.1:65536/cb", "http://127.0.0.1:48123/cb?x=1", "http://127.0.0.1:48123/cb?", "http://127.0.0.1:48123/cb#f",
    "http://127.0.0.1:48123/cb#", "http://user@127.0.0.1:48123/cb", "http://user:pw@127.0.0.1:48123/cb", "javascript:alert(1)", "approvalbox://auth/apple",
    "http://evil.example:48123/cb", "http://127.0.0.1.evil.example:48123/cb", "http://[::2]:48123/cb", "http://0.0.0.0:48123/cb", "http://[::]:48123/cb",
    "http://127.0.0.1:48123@evil.example/cb", "//127.0.0.1:48123/cb", "/cb", "", "not a url", "http://", "http://127.0.0.1:48123/" + "a".repeat(300),
  ];
  for (const provider of ["apple", "google"] as const) {
    for (const redirect_uri of bad) {
      const res = await x.start(provider, { redirect_uri });
      assert.equal(res.status, 400, `${provider} ${JSON.stringify(redirect_uri)}`);
      assert.equal(res.json.error.code, "validation_failed");
    }
    assert.equal((await x.start(provider, { redirect_uri: null })).status, 400);
    assert.equal((await x.start(provider, { redirect_uri: 5 })).status, 400);
  }
  assert.equal(all(x.db, "select * from auth_flows").length, 0);
});

test("拒否する redirect_uri の理由は、固定の文として各言語に訳される", async () => {
  const x = fixture();
  const res = await x.app.request("/v1/auth/apple/web/start", { method: "POST", headers: { "content-type": "application/json", "accept-language": "en" }, body: JSON.stringify({ code_challenge: x.challenge, code_challenge_method: "S256", redirect_uri: "http://localhost:48123/" }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /^redirect_uri must be http:\/\/127\.0\.0\.1:PORT\//);
  const noGoogle = fixture({ apple_services_id: APPLE_ID });
  const g = await noGoogle.app.request("/v1/auth/google/web/start", { method: "POST", headers: { "content-type": "application/json", "accept-language": "en" }, body: JSON.stringify({ code_challenge: noGoogle.challenge, code_challenge_method: "S256" }) });
  assert.equal(((await g.json()) as { error: { message: string } }).error.message, "Sign in with Google is not configured on this server.");
});

test("Googleの設定が無いサーバーは、Googleの開始を400 validation_failed で断る（Appleは使える）", async () => {
  const x = fixture({ apple_services_id: APPLE_ID });
  const res = await x.start("google");
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "validation_failed");
  assert.equal(res.json.error.message, "このサーバーではGoogleのログインを使えません。");
  assert.equal((await x.start("apple")).status, 200);
  const none = fixture({});
  assert.equal((await none.start("apple")).status, 400);
  assert.equal(all(none.db, "select * from auth_flows").length, 0);
});

test("戻り先はflowに保存した値だけ。リクエストに redirect_uri や似た値を載せても使わない", async () => {
  const x = fixture();
  const started = await x.start("google", { redirect_uri: "http://127.0.0.1:48123/cb" });
  const res = await x.app.request("/auth/google/callback?redirect_uri=http://127.0.0.1:1/evil", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", referer: "http://127.0.0.1:2/", origin: "http://127.0.0.1:3" },
    body: new URLSearchParams({ state: started.json.state, id_token: x.idToken("google", nonceOf(started.json.authorization_url), "g-fixed"), redirect_uri: "http://127.0.0.1:4/evil" }).toString(),
  });
  assert.equal(res.status, 303);
  const back = new URL(res.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, "http://127.0.0.1:48123/cb");
  assert.ok(back.searchParams.get("code"));
});

test("知らない・期限切れの state は、ループバックへは戻さず、アプリのschemeへ unauthorized で戻す", async () => {
  const x = fixture();
  for (const provider of ["apple", "google"] as const) {
    const unknown = await x.callback(provider, { state: "kst_unknown", id_token: "x.y.z" });
    assert.equal(unknown.protocol, "approvalbox:");
    assert.equal(`${unknown.host}${unknown.pathname}`, `auth/${provider}`);
    assert.equal(unknown.searchParams.get("error"), "unauthorized");
    const empty = await x.callback(provider, { id_token: "x.y.z" });
    assert.equal(empty.protocol, "approvalbox:");
    // 取り消しでも、知らない state ならアプリのschemeへ
    const cancelled = await x.callback(provider, { state: "kst_unknown", error: provider === "apple" ? "user_cancelled_authorize" : "access_denied" });
    assert.equal(cancelled.protocol, "approvalbox:");
    assert.equal(cancelled.searchParams.get("error"), "cancelled");
    // 期限切れのflow（保存した戻り先があっても使わない）
    const started = await x.start(provider, { redirect_uri: "http://127.0.0.1:48123/cb" });
    run(x.db, "update auth_flows set expires_at=? where state=?", "2000-01-01T00:00:00.000Z", started.json.state);
    for (const fields of [{ id_token: x.idToken(provider, nonceOf(started.json.authorization_url), "late") }, { error: "access_denied" }]) {
      const expired = await x.callback(provider, { state: started.json.state, ...fields });
      assert.equal(expired.protocol, "approvalbox:");
      assert.equal(expired.searchParams.get("state"), started.json.state);
    }
  }
});

test("取り消し・提供元のエラーは、保存したループバックへ error と state で戻り、flowは使い切りにならない", async () => {
  const x = fixture();
  for (const [provider, cancel] of [["apple", "user_cancelled_authorize"], ["google", "access_denied"]] as const) {
    const started = await x.start(provider, { redirect_uri: "http://127.0.0.1:48123/cb" });
    const cancelled = await x.callback(provider, { state: started.json.state, error: cancel });
    assert.equal(`${cancelled.origin}${cancelled.pathname}`, "http://127.0.0.1:48123/cb");
    assert.equal(cancelled.searchParams.get("error"), "cancelled");
    assert.equal(cancelled.searchParams.get("state"), started.json.state);
    assert.equal(cancelled.searchParams.get("code"), null);
    const failed = await x.callback(provider, { state: started.json.state, error: "server_error" });
    assert.equal(`${failed.origin}${failed.pathname}`, "http://127.0.0.1:48123/cb");
    assert.equal(failed.searchParams.get("error"), `${provider}_error`);
    // 取り消しの後も、同じflowで本物の戻りは一度だけ通る（takeAuthFlow は変わらない）
    const ok = await x.callback(provider, { state: started.json.state, id_token: x.idToken(provider, nonceOf(started.json.authorization_url), `${provider}-after-cancel`) });
    assert.ok(ok.searchParams.get("code"));
    // 二度目は使えず、エラーも保存した戻り先へ
    const replay = await x.callback(provider, { state: started.json.state, id_token: x.idToken(provider, nonceOf(started.json.authorization_url), `${provider}-after-cancel`) });
    assert.equal(`${replay.origin}${replay.pathname}`, "http://127.0.0.1:48123/cb");
    assert.equal(replay.searchParams.get("error"), "unauthorized");
    assert.equal(replay.searchParams.get("code"), null);
  }
});

test("照合に失敗した戻り（nonce違い・id_tokenなし・別の宛先のtoken）も、保存したループバックへ error で戻る", async () => {
  const x = fixture();
  const a = await x.start("google", { redirect_uri: "http://[::1]:48123/cb" });
  const wrongNonce = await x.callback("google", { state: a.json.state, id_token: x.idToken("google", "wrong", "g-bad") });
  assert.equal(`${wrongNonce.origin}${wrongNonce.pathname}`, "http://[::1]:48123/cb");
  assert.equal(wrongNonce.searchParams.get("error"), "unauthorized");
  const b = await x.start("google", { redirect_uri: "http://[::1]:48123/cb" });
  const missing = await x.callback("google", { state: b.json.state });
  assert.equal(`${missing.origin}${missing.pathname}`, "http://[::1]:48123/cb");
  assert.equal(missing.searchParams.get("error"), "google_error");
  // Appleのtokenの発行者はGoogleでは通らない
  const c = await x.start("google", { redirect_uri: "http://[::1]:48123/cb" });
  const apple = await x.callback("google", { state: c.json.state, id_token: x.idToken("apple", nonceOf(c.json.authorization_url), "g-apple") });
  assert.equal(apple.searchParams.get("error"), "unauthorized");
  assert.equal(apple.searchParams.get("code"), null);
});

test("別の提供元のcallbackは、flowを使い切りにせず断り、戻り先もそのflowの値にならない", async () => {
  const x = fixture();
  for (const [flowProvider, wrongProvider] of [["google", "apple"], ["apple", "google"]] as const) {
    const started = await x.start(flowProvider, { redirect_uri: "http://127.0.0.1:48123/cb" });
    const nonce = nonceOf(started.json.authorization_url);
    // flowの提供元のtokenを、違う提供元のcallbackへ
    const refused = await x.callback(wrongProvider, { state: started.json.state, id_token: x.idToken(flowProvider, nonce, "cross") });
    assert.equal(refused.protocol, "approvalbox:");
    assert.equal(`${refused.host}${refused.pathname}`, `auth/${wrongProvider}`);
    assert.equal(refused.searchParams.get("error"), "unauthorized");
    assert.equal(refused.searchParams.get("code"), null);
    // 違う提供元のcallbackからの取り消しも、flowの戻り先には行かない
    const cancelled = await x.callback(wrongProvider, { state: started.json.state, error: "access_denied" });
    assert.equal(cancelled.protocol, "approvalbox:");
    // 断られただけでflowは残っているので、正しい提供元のcallbackは通る
    const ok = await x.callback(flowProvider, { state: started.json.state, id_token: x.idToken(flowProvider, nonce, "cross") });
    assert.equal(`${ok.origin}${ok.pathname}`, "http://127.0.0.1:48123/cb");
    assert.ok(ok.searchParams.get("code"));
  }
  assert.equal(all(x.db, "select * from identities where provider='apple' and subject='cross'").length, 1);
  assert.equal(all(x.db, "select * from identities where provider='google' and subject='cross'").length, 1);
});

test("Googleの流れを最後まで: 同じGoogle IDは同じアカウント、AppleのIDとは別のアカウント", async () => {
  const x = fixture();
  const login = async (provider: "apple" | "google", sub: string, redirect_uri?: string) => {
    const started = await x.start(provider, redirect_uri ? { redirect_uri } : {});
    const back = await x.callback(provider, { state: started.json.state, id_token: x.idToken(provider, nonceOf(started.json.authorization_url), sub) });
    const linked = await x.link(back.searchParams.get("code")!);
    assert.equal(linked.status, 200);
    const { session } = await linked.json() as { session: string };
    return x.accounts.userBySession(session);
  };
  const first = await login("google", "same-id", "http://127.0.0.1:48123/cb");
  const second = await login("google", "same-id", "http://[::1]:48124/cb");
  const apple = await login("apple", "same-id", "http://127.0.0.1:48123/cb");
  assert.equal(second, first);
  assert.notEqual(apple, first);
  // callbackで作った一時sessionは、アプリに渡さず失効している
  assert.equal(all(x.db, "select * from sessions where user_id=? and label='google'", first).length, 0);
});

test("auth_flows.redirect_uri の移行: 列の無いDBを開くと列が足され、行が残る（版11・版6のどちらからでも）", () => {
  for (const version of [11, 6]) {
    const dir = join(mkdtempSync(join(tmpdir(), "ab-desktop-login-")), `v${version}.db`);
    openDb(dir).close();
    const old = new DatabaseSync(dir);
    old.exec(`insert into auth_flows (state,provider,nonce,code_challenge,created_at,expires_at) values ('s1','apple','n','c','2026-11-19','2999-01-01');
      alter table auth_flows drop column redirect_uri; pragma user_version = ${version};`);
    old.close();
    const db = openDb(dir);
    assert.ok(all<{ name: string }>(db, "select name from pragma_table_info('auth_flows')").some((c) => c.name === "redirect_uri"));
    assert.deepEqual(all(db, "select state, redirect_uri from auth_flows").map((r) => ({ ...r })), [{ state: "s1", redirect_uri: null }]);
    assert.equal(get<{ user_version: number }>(db, "pragma user_version")?.user_version, 16);
    db.close();
    openDb(dir).close(); // 二度目は何も変えない
  }
});
