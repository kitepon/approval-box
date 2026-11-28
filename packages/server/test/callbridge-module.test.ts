// call-bridge を認証モジュールの http-stream 越しに話す（s01c）。モジュールの代役を一時のソケットに立て、枠のやり取りと MCP の一巡を確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleFetch } from "../src/auth-module.ts";
import { callBridgeSender } from "../src/callbridge.ts";

const posix = { skip: process.platform === "win32" ? "unix ソケットは Linux だけ" : false };
const frame = (tag: number, data: string | Buffer) => {
  const body = Buffer.from(data);
  const head = Buffer.alloc(5);
  head[0] = tag;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
type Seen = { op: string; name: string; method: string; path: string; headers: Record<string, string>; json?: { id?: number; method?: string; params?: { name?: string; protocolVersion?: string } } };

/** end: 枠の終わりの tag 3（既定 "0"）。first: 先頭の1行（granted 以外）。 */
// 注: SDK は途中で切れた POST の SSE を待ち続け、60 秒の要求の時間切れで失敗にする（直の fetch でも同じ）。そのため終了コードの試験は moduleFetch の本文まで。
async function fakeModule(options: { first?: Record<string, unknown>; end?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-callbridge-module-"));
  const path = join(dir, "approval-box.sock");
  const seen: Seen[] = [];
  const sockets: Socket[] = [];
  let closed = 0;
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on("close", () => { closed++; });
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Seen & { body?: string };
      buffer = "";
      const json = request.body ? JSON.parse(Buffer.from(request.body, "base64").toString("utf8")) as Seen["json"] : undefined;
      seen.push({ ...request, ...(json ? { json } : {}) });
      const write = async (data: Buffer) => { for (let i = 0; i < data.length; i += 7) { socket.write(data.subarray(i, i + 7)); await new Promise((r) => setImmediate(r)); } };
      if (options.first) return void socket.end(`${JSON.stringify(options.first)}\n`);
      await write(Buffer.from('{"outcome":"granted"}\n'));
      const reply = (status: number, headers: Record<string, string>, body?: unknown) => [frame(5, JSON.stringify({ status, headers })), ...(body === undefined ? [] : [frame(4, ""), frame(1, sse(body))])];
      let frames: Buffer[];
      if (request.method === "GET") frames = reply(405, {});
      else if (request.method === "DELETE") frames = reply(200, {});
      else if (json?.method === "initialize") frames = reply(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess1", "MCP-Protocol-Version": json.params!.protocolVersion! }, { jsonrpc: "2.0", id: json.id, result: { protocolVersion: json.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
      else if (json?.method === "tools/call") {
        const structured = json.params!.name === "call_open" ? { session_id: "s1" } : { delivery: { status: "queued" }, seq: 3 };
        frames = reply(200, { "content-type": "text/event-stream" }, { jsonrpc: "2.0", id: json.id, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured } });
      } else frames = reply(202, {});
      await write(Buffer.concat([...frames, frame(3, options.end ?? "0")]));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, seen, sockets, closed: () => closed, async stop() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
}
const config = (fetch: ReturnType<typeof moduleFetch>) => ({ url: "https://call.kitepon.dev/mcp", fetch, localSystem: "local", localId: "approval-box", localLabel: "Approval Box", memberSystem: "grokbot" });
const settle = async (until: () => boolean) => { for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 20)); };

test("a full call goes through http-stream with no authorization header, and every socket is closed", posix, async (t) => {
  const mod = await fakeModule();
  t.after(() => mod.stop());
  const result = await callBridgeSender(config(moduleFetch(mod.path, "approvalbox-callbridge")))("grok-1", "K-1", "hello");
  assert.equal(result.state, "delivered");
  assert.match(result.detail ?? "", /call s1 seq 3/);
  const methods = mod.seen.filter((r) => r.method !== "GET").map((r) => r.json?.method === "tools/call" ? `${r.json.method}:${r.json.params!.name}` : r.json?.method ?? r.method);
  assert.deepEqual(methods.slice(0, 4), ["initialize", "notifications/initialized", "tools/call:call_open", "tools/call:call_send"]);
  for (const request of mod.seen) {
    assert.equal(request.op, "http-stream");
    assert.equal(request.name, "approvalbox-callbridge");
    assert.equal(request.path, "/mcp");
    assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase() === "authorization"), false);
  }
  const lowered = (r: Seen) => Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lowered(mod.seen[0]!)["mcp-session-id"], undefined);
  assert.equal(lowered(mod.seen[2]!)["mcp-session-id"], "sess1");
  assert.ok(lowered(mod.seen[2]!)["mcp-protocol-version"]);
  await settle(() => mod.closed() === mod.sockets.length);
  assert.equal(mod.closed(), mod.sockets.length);
  assert.ok(mod.sockets.length >= 4);
});

test("a denied first line is a failure and nothing was sent", posix, async (t) => {
  for (const outcome of ["denied", "unknown-caller", "not-registered", "error"]) {
    const mod = await fakeModule({ first: { outcome, error: "x" } });
    t.after(() => mod.stop());
    await assert.rejects(moduleFetch(mod.path, "approvalbox-callbridge")("https://call.kitepon.dev/mcp", { method: "POST", body: "{}" }), new RegExp(`auth module approvalbox-callbridge: ${outcome}`));
    const result = await callBridgeSender(config(moduleFetch(mod.path, "approvalbox-callbridge")))("grok-1", "K-1", "hello");
    assert.equal(result.state, "failed");
    await settle(() => mod.closed() === mod.sockets.length);
    assert.equal(mod.closed(), mod.sockets.length);
  }
});

test("an end code other than 0 is a failure: before the body is read, or in the middle of it", posix, async (t) => {
  const mod = await fakeModule({ end: "1" });
  t.after(() => mod.stop());
  const response = await moduleFetch(mod.path, "approvalbox-callbridge")("https://call.kitepon.dev/mcp", { method: "POST", body: "{}" });
  await assert.rejects(response.text(), /stream cut \(1\)/);
  await settle(() => mod.closed() === mod.sockets.length);
  assert.equal(mod.closed(), mod.sockets.length);
});

test("aborting a request closes its socket, and a missing module is a failure", posix, async (t) => {
  const mod = await fakeModule();
  t.after(() => mod.stop());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(moduleFetch(mod.path, "approvalbox-callbridge")("https://call.kitepon.dev/mcp", { signal: controller.signal }));
  assert.equal(mod.sockets.length, 0);
  await assert.rejects(moduleFetch(join(tmpdir(), "no-such-auth-module.sock"), "approvalbox-callbridge")("https://call.kitepon.dev/mcp"), /unreachable/);
});
