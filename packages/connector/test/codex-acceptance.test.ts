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
  const args = { title: "受付確認", options: [{ id: "ok", label: "確認" }] };
  const first = await client.callTool({ name: "request_decision", arguments: args, _meta: { threadId } });
  assert.equal((first.structuredContent as any)?.check_token, "test-confirm", JSON.stringify(first));
  const accepted = await client.callTool({ name: "request_decision", arguments: { ...args, check_token: "test-confirm" }, _meta: { threadId } });
  assert.equal((accepted.structuredContent as any)?.decision_id, "K-TEST");
  // 案内は structuredContent にも載る（Claude Code は成功した返りを structuredContent だけでAIへ渡す）。答えの届き方と確かめ方を先に伝える。
  const guide = String((accepted.structuredContent as any)?.guide);
  assert.match(guide, /^申請しました: K-TEST/);
  assert.match(guide, /「\[Approval Box\]」で始まる文として自動で届きます/);
  assert.match(guide, /get_decision で確かめられます/);
  assert.ok((accepted.content as any)[0].text.startsWith(guide));
  assert.notEqual(accepted.isError, true);
  const resumed = await client.callTool({ name: "resume_decision", arguments: { decision_id: "K-TEST" }, _meta: { threadId } });
  assert.notEqual(resumed.isError, true);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]?.route.harness, "codex");
  assert.equal(bodies[0]?.route.channel_id, bodies[1]?.route.channel_id);
  assert.equal(bodies[2]?.channel_id, bodies[1]?.route.channel_id);
  const unidentified = await client.callTool({ name: "request_decision", arguments: args });
  assert.equal(unidentified.isError, true);
  assert.match(JSON.stringify(unidentified.content), /threadId/);
  assert.equal(bodies.length, 3, "元会話を識別できない申請は送らない");
});
