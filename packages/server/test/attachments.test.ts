import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Accounts } from "../src/accounts.ts";
import { Attachments, MAX_FILE_BYTES, contentDisposition } from "../src/attachments.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png")]);
const PDF = Buffer.from("%PDF-1.7\nfake pdf\n");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(12)]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abx-att-"));
  const db = openDb(":memory:");
  const events = new EventHub(db);
  const accounts = new Accounts(db, events, "store");
  const decisions = new Decisions(db, events);
  const attachments = new Attachments(db, dir);
  const app = createApp({ db, accounts, decisions, events, publicUrl: "https://kb.test", attachments, remoteMcp: { attachments } });
  const userId = accounts.createUser();
  const { session } = accounts.issueSession(userId, "test");
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json" },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const upload = async (id: string, data: Buffer, type: string, name: string, opts: { token?: string; key?: string | null } = {}) => {
    const res = await app.request(`/v1/decisions/${id}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token ?? session}`, "content-type": type,
        ...(opts.key === null ? {} : { "idempotency-key": opts.key ?? crypto.randomUUID() }),
      },
      body: new Uint8Array(data),
    });
    return { status: res.status, json: await res.json() };
  };
  const files = () => readdirSync(dir);
  return { dir, db, app, accounts, decisions, call, upload, files, session, userId, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ask = { title: "画面の直し方を決めてほしい", context: "崩れている画面がある", options: [{ id: "a", label: "直す" }, { id: "b", label: "後で" }], session_label: "web", client: "claude-code", route: { channel_id: "ch-1", harness: "claude" } };

/** 接続トークンを作り、札の往復で申請する。 */
async function decision(ctx: ReturnType<typeof setup>) {
  const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "pc" } });
  const token = issued.json.token as string;
  const first = await ctx.call("POST", "/connector/v1/decisions", { token, body: ask });
  const made = await ctx.call("POST", "/connector/v1/decisions", { token, body: { ...ask, check_token: first.json.error.check_token } });
  assert.equal(made.status, 200);
  return { token, id: made.json.decision_id as string };
}

test("添付: 画像と書類を上げ、答えと一緒に結び、AIが取れる", async () => {
  const ctx = setup();
  try {
    const { token, id } = await decision(ctx);
    const png = await ctx.upload(id, PNG, "image/png", "画面.png");
    assert.equal(png.status, 200);
    assert.match(png.json.id, /^att_/);
    assert.equal(png.json.kind, "image");
    assert.equal(png.json.name, "画面.png");
    const pdf = await ctx.upload(id, PDF, "application/pdf; charset=binary", "../仕様\n書.pdf");
    assert.equal(pdf.json.kind, "document");
    assert.equal(pdf.json.name, "..仕様書.pdf", "改行と区切りを除く");
    const extra = await ctx.upload(id, PNG, "image/png", "要らない.png");

    const staged = await ctx.call("GET", `/v1/decisions/${id}/attachments`, { token: ctx.session });
    assert.equal(staged.json.items.length, 3);
    // 下書きの段階では version は変わらない
    const before = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
    assert.equal(before.json.version, 1);

    // 下書きは利用者が取れるが、AIはまだ取れない
    const draft = await ctx.app.request(`/v1/decisions/${id}/attachments/${png.json.id}`, { headers: { authorization: `Bearer ${ctx.session}` } });
    assert.equal(draft.status, 200);
    assert.equal(draft.headers.get("content-type"), "image/png");
    assert.equal(draft.headers.get("etag"), `"${png.json.sha256}"`);
    assert.match(draft.headers.get("content-disposition")!, /filename\*=UTF-8''%E7%94%BB%E9%9D%A2\.png/);
    assert.deepEqual(Buffer.from(await draft.arrayBuffer()), PNG);
    const early = await ctx.app.request(`/connector/v1/decisions/${id}/attachments/${png.json.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(early.status, 404);

    const answered = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { text: "この2つを見て", attachment_ids: [pdf.json.id, png.json.id], version: 1 } });
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.json.answer.attachments.map((a: { id: string }) => a.id), [pdf.json.id, png.json.id], "送った順");
    assert.equal(answered.json.answer.attachments[0].sha256, pdf.json.sha256);

    // 結ばなかった下書きは消え、ファイルも片付く
    assert.equal(ctx.files().includes(extra.json.id), false);
    assert.equal(ctx.files().length, 2);
    const gone = await ctx.app.request(`/v1/decisions/${id}/attachments/${extra.json.id}`, { headers: { authorization: `Bearer ${ctx.session}` } });
    assert.equal(gone.status, 404);
    // 結んだ後は個別削除できない
    const del = await ctx.call("DELETE", `/v1/decisions/${id}/attachments/${png.json.id}`, { token: ctx.session });
    assert.equal(del.status, 409);

    // AIへの配送の文と、コネクタからの取得
    const deliveries = await ctx.call("GET", "/connector/v1/deliveries", { token });
    const text = deliveries.json.items[0].text as string;
    assert.match(text, /添付 2件/);
    assert.match(text, new RegExp(`1\\. \\.\\.仕様書\\.pdf（application/pdf、.*attachment_id=${pdf.json.id}`));
    assert.match(text, /get_attachment/);
    const got = await ctx.app.request(`/connector/v1/decisions/${id}/attachments/${pdf.json.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PDF);
    const ai = await ctx.call("GET", `/connector/v1/decisions/${id}`, { token });
    assert.equal(ai.json.answer.attachments.length, 2);

    // 他のアカウントからは見えない
    const other = ctx.accounts.issueSession(ctx.accounts.createUser(), "other").session;
    const peek = await ctx.app.request(`/v1/decisions/${id}/attachments/${png.json.id}`, { headers: { authorization: `Bearer ${other}` } });
    assert.equal(peek.status, 404);
    const otherToken = (await ctx.call("POST", "/v1/tokens", { token: other, body: { label: "x" } })).json.token;
    const peekAi = await ctx.app.request(`/connector/v1/decisions/${id}/attachments/${png.json.id}`, { headers: { authorization: `Bearer ${otherToken}` } });
    assert.equal(peekAi.status, 404);
    const push = await ctx.upload(id, PNG, "image/png", "x.png", { token: other });
    assert.equal(push.status, 404);

    // 答えた後は上げられない
    const late = await ctx.upload(id, PNG, "image/png", "late.png");
    assert.equal(late.status, 409);

    // 既決を消すと添付も消える
    const wiped = await ctx.call("DELETE", "/v1/decisions?status=answered,cancelled", { token: ctx.session });
    assert.equal(wiped.json.deleted, 1);
    assert.equal(ctx.files().length, 0);
    const after = await ctx.app.request(`/connector/v1/decisions/${id}/attachments/${pdf.json.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("添付: 添付だけの答え、version違いでも下書きは残る、送り直しは二重にならない", async () => {
  const ctx = setup();
  try {
    const { token, id } = await decision(ctx);
    const key = crypto.randomUUID();
    const first = await ctx.upload(id, HEIC, "image/heic", "IMG_0001.HEIC", { key });
    assert.equal(first.status, 200);
    const again = await ctx.upload(id, HEIC, "image/heic", "IMG_0001.HEIC", { key });
    assert.equal(again.json.id, first.json.id);
    assert.equal(ctx.files().length, 1);
    const changed = await ctx.upload(id, PNG, "image/png", "other.png", { key });
    assert.equal(changed.status, 400);

    // AIが直して version が上がる → 古い version の答えは409、下書きは残る
    const amended = await ctx.call("POST", `/connector/v1/decisions/${id}/amend`, { token, body: { version: 1, note: "背景を足した", changes: { context: "崩れている画面がある（iPhone）" } } });
    assert.equal(amended.json.version, 2);
    const stale = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { attachment_ids: [first.json.id], version: 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.decision.version, 2);
    const staged = await ctx.call("GET", `/v1/decisions/${id}/attachments`, { token: ctx.session });
    assert.equal(staged.json.items.length, 1);

    // 知らないidが混ざれば答え全体を断る
    const bad = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { attachment_ids: [first.json.id, "att_nope"], version: 2 } });
    assert.equal(bad.status, 400);
    const dup = await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { attachment_ids: [first.json.id, first.json.id], version: 2 } });
    assert.equal(dup.status, 400);
    const still = await ctx.call("GET", `/v1/decisions/${id}`, { token: ctx.session });
    assert.equal(still.json.status, "pending");

    const idem = crypto.randomUUID();
    const send = () => ctx.app.request(`/v1/decisions/${id}/answer`, {
      method: "POST", headers: { authorization: `Bearer ${ctx.session}`, "content-type": "application/json", "idempotency-key": idem },
      body: JSON.stringify({ attachment_ids: [first.json.id], version: 2 }),
    });
    const ok = await send();
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.answer.option_id, undefined);
    assert.equal(body.answer.text, undefined);
    assert.equal(body.answer.attachments[0].content_type, "image/heic");
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), body);

    const deliveries = await ctx.call("GET", "/connector/v1/deliveries", { token });
    assert.match(deliveries.json.items[0].text, /添付を確かめて作業を続けてください/);

    // 何も無い答えは断る
    const { id: id2 } = await decision(ctx);
    const empty = await ctx.call("POST", `/v1/decisions/${id2}/answer`, { token: ctx.session, body: { attachment_ids: [], version: 1 } });
    assert.equal(empty.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("添付: 形式・大きさ・数の上限と、取り下げ・アカウント削除での片付け", async () => {
  const ctx = setup();
  try {
    const { token, id } = await decision(ctx);
    assert.equal((await ctx.upload(id, Buffer.from("MZ\x90\x00"), "application/x-msdownload", "a.exe")).status, 415);
    const mismatch = await ctx.upload(id, PDF, "image/png", "fake.png");
    assert.equal(mismatch.status, 415);
    assert.equal(mismatch.json.error.code, "unsupported_type");
    assert.equal((await ctx.upload(id, Buffer.from([0xff, 0xfe, 0x00, 0x41]), "text/plain", "bin.txt")).status, 415);
    assert.equal((await ctx.upload(id, Buffer.alloc(0), "text/plain", "empty.txt")).status, 400);
    assert.equal((await ctx.upload(id, PNG, "image/png", "nokey.png", { key: null })).status, 400);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    const tooBig = await ctx.upload(id, big, "application/pdf", "big.pdf");
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error.code, "too_large");
    for (let i = 0; i < 10; i++) assert.equal((await ctx.upload(id, Buffer.from(`メモ${i}`), "text/markdown", `m${i}.md`)).status, 200);
    assert.equal((await ctx.upload(id, PNG, "image/png", "11.png")).status, 413);
    assert.equal(ctx.files().filter((f) => f.endsWith(".part")).length, 0, "断った途中のファイルを残さない");
    // 個別削除で枠が空く
    const items = (await ctx.call("GET", `/v1/decisions/${id}/attachments`, { token: ctx.session })).json.items;
    assert.equal((await ctx.call("DELETE", `/v1/decisions/${id}/attachments/${items[0].id}`, { token: ctx.session })).status, 200);
    assert.equal(ctx.files().length, 9);
    assert.equal((await ctx.upload(id, PNG, "image/png", "11.png")).status, 200);

    // AIが取り下げると下書きは消える
    await ctx.call("POST", `/connector/v1/decisions/${id}/cancel`, { token, body: { reason: "別の方法で片付いた" } });
    assert.equal(ctx.files().length, 0);

    // アカウント削除で全部消える
    const { id: id2 } = await decision(ctx);
    const kept = await ctx.upload(id2, PNG, "image/png", "k.png");
    await ctx.call("POST", `/v1/decisions/${id2}/answer`, { token: ctx.session, body: { attachment_ids: [kept.json.id], version: 1 } });
    assert.equal(ctx.files().length, 1);
    assert.equal((await ctx.call("DELETE", "/v1/me", { token: ctx.session })).status, 200);
    assert.equal(ctx.files().length, 0);
    assert.equal(existsSync(ctx.dir), true);
  } finally {
    ctx.cleanup();
  }
});

test("添付: 保存日数を過ぎた既決と、24時間結ばれない下書きは消える", async () => {
  const ctx = setup();
  try {
    const { id } = await decision(ctx);
    const staged = await ctx.upload(id, PNG, "image/png", "s.png");
    ctx.db.prepare("update attachments set created_at = ? where id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), staged.json.id);
    const bound = await ctx.upload(id, PDF, "application/pdf", "b.pdf");
    await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { option_id: "a", attachment_ids: [bound.json.id], version: 1 } });
    assert.equal(ctx.files().length, 1, "答えた時に結ばなかった下書きは消える");

    const { id: id2 } = await decision(ctx);
    const old = await ctx.upload(id2, PNG, "image/png", "old.png");
    ctx.db.prepare("update attachments set created_at = ? where id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), old.json.id);
    new Attachments(ctx.db, ctx.dir).gc();
    assert.equal(ctx.files().length, 1);
    assert.equal((await ctx.call("GET", `/v1/decisions/${id2}/attachments`, { token: ctx.session })).json.items.length, 0);

    ctx.db.prepare("update decisions set updated_at = ? where id = ?").run(new Date(Date.now() - 40 * 86400_000).toISOString(), id);
    ctx.decisions.purgeExpired();
    new Attachments(ctx.db, ctx.dir).gc();
    assert.equal(ctx.files().length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("添付: リモートMCPの get_attachment は画像を image、書類をファイルで返す", async () => {
  const ctx = setup();
  try {
    const issued = await ctx.call("POST", "/v1/tokens", { token: ctx.session, body: { label: "Grok" } });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://kb.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${issued.json.token}` } },
      fetch: (url, init) => ctx.app.fetch(new Request(url, init)),
    }));
    const req = { title: "どれにするか", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], session_label: "grok" };
    const first = (await client.callTool({ name: "request_decision", arguments: req })) as any;
    const made = (await client.callTool({ name: "request_decision", arguments: { ...req, check_token: first.structuredContent.check_token } })) as any;
    const id = made.structuredContent.decision_id;
    const png = await ctx.upload(id, PNG, "image/png", "p.png");
    const pdf = await ctx.upload(id, PDF, "application/pdf", "d.pdf");
    const md = await ctx.upload(id, Buffer.from("# メモ"), "text/markdown", "m.md");
    await ctx.call("POST", `/v1/decisions/${id}/answer`, { token: ctx.session, body: { attachment_ids: [png.json.id, pdf.json.id, md.json.id], version: 1 } });

    const image = (await client.callTool({ name: "get_attachment", arguments: { decision_id: id, attachment_id: png.json.id } })) as any;
    assert.equal(image.content[1].type, "image");
    assert.equal(image.content[1].mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.content[1].data, "base64"), PNG);
    const doc = (await client.callTool({ name: "get_attachment", arguments: { decision_id: id, attachment_id: pdf.json.id } })) as any;
    assert.equal(doc.content[1].type, "resource");
    assert.deepEqual(Buffer.from(doc.content[1].resource.blob, "base64"), PDF);
    const text = (await client.callTool({ name: "get_attachment", arguments: { decision_id: id, attachment_id: md.json.id } })) as any;
    assert.equal(text.content[1].resource.text, "# メモ");
    const missing = (await client.callTool({ name: "get_attachment", arguments: { decision_id: id, attachment_id: "att_x" } })) as any;
    assert.equal(missing.isError, true);
  } finally {
    ctx.cleanup();
  }
});

test("添付: Content-Disposition は ASCII の名前と UTF-8 の名前を両方持つ", () => {
  assert.equal(contentDisposition("a b.png"), `attachment; filename="a b.png"; filename*=UTF-8''a%20b.png`);
  assert.equal(contentDisposition(`見"積'.pdf`), `attachment; filename="___'.pdf"; filename*=UTF-8''%E8%A6%8B%22%E7%A9%8D%27.pdf`);
});
