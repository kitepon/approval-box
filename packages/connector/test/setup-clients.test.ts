import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";

test("partial standard setup keeps the other clients in the server registration", { timeout: 30_000 }, async t => {
  // macOS tmpdir is /var → /private/var; the CLI derives its runtime entry from the real path, so the fake daemon entry must match it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ab-setup-clients-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = "0.0.0-test", product = join(root, "product"), claude = join(root, "claude");
  mkdirSync(claude);
  mkdirSync(join(product, "state"), { recursive: true });
  const original = { mcpServers: { foreign: { command: "preserved" } }, foreignSetting: true };
  writeFileSync(join(claude, ".claude.json"), JSON.stringify(original));
  const cli = join(root, "dist", "cli.mjs");
  buildSync({ entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))], outfile: cli,
    bundle: true, platform: "node", format: "esm", define: { __APPROVAL_BOX_VERSION__: JSON.stringify(version) },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  // Keep daemon handling local: the test process represents an already running same-version daemon.
  writeFileSync(join(product, "state", "daemon.json"), JSON.stringify({ pid: process.pid, entry: join(product, "runtime", version, "cli.mjs") }));
  const existing = ["codex", "cursor", "grok", "claude-code"];
  let saved: string[] | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/connector/v1/connection") res.end(JSON.stringify({ clients: existing }));
    else if (req.method === "PUT" && req.url === "/connector/v1/connection/clients") {
      let body = "";
      for await (const part of req) body += part;
      saved = JSON.parse(body).clients;
      res.end("{}");
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(product, "config.json"), JSON.stringify({ server: url, token: "local-test-only" }));
  const child = spawn(process.execPath, [cli, "setup", "--only", "claude", "--yes", "--no-test", "--no-instructions"], {
    env: { ...process.env, APPROVAL_BOX_HOME: product, CLAUDE_CONFIG_DIR: claude }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exit, 0, output);
  assert.deepEqual(saved, existing, "--only must preserve other clients without duplicating Claude");
  const result = JSON.parse(readFileSync(join(claude, ".claude.json"), "utf8"));
  assert.equal(result.foreignSetting, true);
  assert.deepEqual(result.mcpServers.foreign, original.mcpServers.foreign);
  assert.ok(result.mcpServers["approval-box"].args[0].includes(version));
});
