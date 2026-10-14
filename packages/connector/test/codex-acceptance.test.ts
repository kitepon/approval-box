import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeJsonFile } from "../src/config.ts";

test("Codex申請の確認・受付・再開はhookと親アプリ再起動を条件にしない", async t => {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-acceptance-"));
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      bodies.push({ path: req.url, ...parsed });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/resume")) res.end(JSON.stringify({ decision_id: "K-TEST", status: "pending" }));
      else if (!parsed.check_token) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: { code: "confirm_required", message: "一覧を確認", decisions: [], check_token: "test-confirm" } }));
      } else res.end(JSON.stringify({ decision_id: "K-TEST", title: parsed.title, status: "pending" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const absent = join(root, "missing-runtime");
  writeJsonFile(join(root, "config.json"), { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "isolated-test" });
  writeJsonFile(join(root, "codex-parent-hooks", "config.json"), {
    schema: "approval-box.codex-parent-hooks.v1", enabled: true, codex_home: root,
    binary: absent, command: "old-hook", node: absent, hook: absent,
    stale_processes: [{ pid: process.pid, started_identity: "before-hook" }],
  });
  const script = `import { writeJsonFile } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
import { runtimeEntry } from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)};
import { runMcp } from ${JSON.stringify(new URL("../src/mcp.ts", import.meta.url).href)};
writeJsonFile(${JSON.stringify(join(root, "state", "daemon.json"))}, {pid:process.pid, entry:runtimeEntry("cli")});
await runMcp();`;
  const client = new Client({ name: "codex-mcp-client", version: "test" });
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", script],
    env: { ...process.env as Record<string, string>, APPROVAL_BOX_HOME: root, CODEX_HOME: root, CODEX_BIN: absent }, stderr: "pipe" }));
  const threadId = randomUUID();
  // 誰から・何の仕事かは、道具の一覧で必須にして求める（クオの指摘 2026-10-14）。
  const listed = (await client.listTools()).tools.find(tool => tool.name === "request_decision")!;
  assert.deepEqual(listed.inputSchema.required, ["title", "options", "requester_name", "session_label"]);
  const args = { title: "受付確認", options: [{ id: "ok", label: "確認" }], requester_name: " ナユタ ", session_label: "Approval Box / 受付の試験" };
  const first = await client.callTool({ name: "request_decision", arguments: args, _meta: { threadId } });
  assert.equal((first.structuredContent as any)?.check_token, "test-confirm", JSON.stringify(first));
  const accepted = await client.callTool({ name: "request_decision", arguments: { ...args, check_token: "test-confirm" }, _meta: { threadId } });
  assert.equal((accepted.structuredContent as any)?.decision_id, "K-TEST");
  // 案内は structuredContent にも載る（Claude Code は成功した返りを structuredContent だけでAIへ渡す）。答えの届き方と確かめ方を先に伝える。
  const guide = String((accepted.structuredContent as any)?.guide);
  // 利用者はIDを知らない。件名を先に書き、件名で伝えるよう添える。
  assert.ok(guide.startsWith("申請しました: 「受付確認」（申請のID: K-TEST）。"), guide);
  assert.match(guide, /利用者へこの申請の話をする時は、件名で伝えてください。アプリには件名・申請者・作業名が出て、申請のIDは出ません/);
  assert.match(guide, /「\[Approval Box\]」で始まる文として自動で届きます/);
  assert.match(guide, /get_decision で確かめられます/);
  assert.ok((accepted.content as any)[0].text.startsWith(guide));
  assert.notEqual(accepted.isError, true);
  const resumed = await client.callTool({ name: "resume_decision", arguments: { decision_id: "K-TEST" }, _meta: { threadId } });
  assert.notEqual(resumed.isError, true);
  assert.equal(bodies.length, 3);
  // 名前はサーバーへ requester で渡す。道具の引数名（requester_name）のままは送らない。
  assert.equal(bodies[1]?.requester, "ナユタ");
  assert.equal(bodies[1]?.session_label, "Approval Box / 受付の試験");
  assert.equal("requester_name" in bodies[1]!, false);
  assert.equal(bodies[0]?.route.harness, "codex");
  assert.equal(bodies[0]?.route.channel_id, bodies[1]?.route.channel_id);
  assert.equal(bodies[2]?.channel_id, bodies[1]?.route.channel_id);
  const unidentified = await client.callTool({ name: "request_decision", arguments: args });
  assert.equal(unidentified.isError, true);
  assert.match(JSON.stringify(unidentified.content), /threadId/);
  assert.equal(bodies.length, 3, "元会話を識別できない申請は送らない");
  // 道具の一覧を古いまま持つ client は名前と作業名を送らない。その申請も今までどおり受け付け、作業名は作業フォルダ名にする。
  const legacy = await client.callTool({ name: "request_decision", arguments: { title: "古い一覧", options: args.options, check_token: "test-confirm" }, _meta: { threadId } });
  assert.notEqual(legacy.isError, true, JSON.stringify(legacy));
  assert.equal("requester" in bodies[3]!, false);
  assert.match(bodies[3]?.session_label, / \(codex\)$/);
  // 名前を持たないAI（一般の利用者の Codex など）は空文字で出す。その申請には申請者を付けず、今までと同じ見え方にする。
  const nameless = await client.callTool({ name: "request_decision", arguments: { ...args, title: "名前を持たないAI", requester_name: "", check_token: "test-confirm" }, _meta: { threadId } });
  assert.notEqual(nameless.isError, true, JSON.stringify(nameless));
  assert.equal("requester" in bodies[4]!, false);
  assert.equal(bodies[4]?.session_label, "Approval Box / 受付の試験");
});
