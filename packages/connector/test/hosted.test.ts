// --hosted (c8h): before pairing, the daemon answers GET /status and refuses decision routes with not_paired; SIGTERM exits 0.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ServerError } from "../src/api.ts";
import { LocalApi } from "../src/local-api.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("hosted daemon without pairing: status not_paired, decisions 503 not_paired, no idle path, SIGTERM exit 0", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-hosted-"));
  const child = spawn(process.execPath, [cli, "daemon", "--hosted"], { env: { ...process.env, APPROVAL_BOX_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  try {
    const sock = join(home, "state", "pc", "daemon.sock");
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    const api = new LocalApi(sock, 5000);
    const status = await api.call<{ schema: string; mode: string; paired: boolean; reason: string }>("GET", "/status");
    assert.deepEqual([status.schema, status.mode, status.paired, status.reason], ["approval-box.daemon-status.v1", "not_paired", false, "not_paired"]);
    await assert.rejects(api.call("GET", "/decisions"), (e: unknown) => e instanceof ServerError && e.status === 503 && e.code === "not_paired");
    assert.match(stderr, /not_paired/);
    const exit = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    assert.equal(await exit, 0);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("pair --json: status reads the files; --rebind without a saved connection fails by name with exit 1", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-pair-"));
  const run = (...args: string[]) => new Promise<{ code: number | null; out: string }>((r) => {
    const c = spawn(process.execPath, [cli, ...args], { env: { ...process.env, APPROVAL_BOX_HOME: home }, stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.once("exit", (code) => r({ code, out }));
  });
  try {
    const st = await run("pair", "status", "--json");
    assert.deepEqual([st.code, JSON.parse(st.out)], [0, { schema: "approval-box.pair-status.v1", paired: false }]);
    const rb = await run("pair", "--json", "--rebind");
    assert.equal(rb.code, 1);
    assert.deepEqual([JSON.parse(rb.out).state, JSON.parse(rb.out).code], ["failed", "not_paired"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
