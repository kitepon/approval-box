// pair --json --v1: the /connector/v1 path without peer-channel keys (BellTeam body joins by the app's QR reader).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemonPeerChannel, useLocalApi } from "../src/daemon.ts";
import { pcPrepared, readMode } from "../src/pc-mode.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A server that never offers peer_channel; the pairing is claimed on the first poll. */
async function fakeServer(claim: "claimed" | "rejected" = "claimed") {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/auth/config") return json({ peer_channel: false });
    if (req.method === "POST" && req.url === "/connector/v1/pairing") return json({ pairing_id: "p1", code: "ABCD2345", qr_url: "https://ab.example/pair?c=ABCD2345", poll_secret: "s", expires_at: "2030-01-01T00:00:00.000Z" });
    if (req.url === "/connector/v1/pairing/p1") return json(claim === "claimed" ? { status: "claimed", token: "tok-1", connection_id: "conn-1" } : { status: "rejected" });
    res.statusCode = 404; json({ error: "not_found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const run = (home: string, ...args: string[]) => new Promise<{ code: number | null; lines: Record<string, unknown>[] }>((r) => {
  const c = spawn(process.execPath, [cli, ...args], { env: { ...process.env, APPROVAL_BOX_HOME: home }, stdio: ["ignore", "pipe", "ignore"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.once("exit", (code) => r({ code, lines: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
});
const withHome = async (body: (home: string) => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), "ab-pairv1-"));
  try { await body(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const putKeys = (home: string) => { // what a peer-channel pairing leaves behind
  mkdirSync(join(home, "state", "pc"), { recursive: true });
  writeFileSync(join(home, "state", "pc", "keys.json"), "{}");
  writeFileSync(join(home, "state", "pc", "admission.json"), "{}");
};

test("pair --json --v1: waiting carries the server's qr_url, no binding call, claimed writes the v1 config and exits 0", { timeout: 30_000 }, async () => {
  const s = await fakeServer();
  try {
    await withHome(async (home) => {
      const r = await run(home, "pair", "--json", "--v1", "--server", s.url, "--name", "body");
      assert.equal(r.code, 0);
      assert.deepEqual(r.lines, [
        { schema: "approval-box.pair.v1", state: "waiting", pairing_id: "p1", code: "ABCD2345", qr_text: "https://ab.example/pair?c=ABCD2345", expires_at: "2030-01-01T00:00:00.000Z" },
        { schema: "approval-box.pair.v1", state: "claimed", connection_id: "conn-1", path: "v1" },
      ]);
      assert.equal(s.hits.includes("GET /v1/auth/config"), false); // peerChannelBinding was never called
      assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { server: s.url, token: "tok-1", connection_id: "conn-1", device_name: "body", path: "v1" });
      const st = await run(home, "pair", "status", "--json");
      assert.deepEqual(st.lines, [{ schema: "approval-box.pair-status.v1", paired: true, connection_id: "conn-1", server: s.url, path: "v1" }]);
      const rb = await run(home, "pair", "--json", "--rebind"); // no keys to bind on a /v1 connection
      assert.deepEqual([rb.code, rb.lines[0]?.code], [1, "v1_connection"]);
    });
  } finally { await s.close(); }
});

test("pair --json --v1: a rejected pairing is failed with exit 1 and writes no config", { timeout: 30_000 }, async () => {
  const s = await fakeServer("rejected");
  try {
    await withHome(async (home) => {
      const r = await run(home, "pair", "--json", "--v1", "--server", s.url);
      assert.deepEqual([r.code, r.lines.map((l) => l.state), r.lines[1]?.code], [1, ["waiting", "failed"], "rejected"]);
      assert.equal(existsSync(join(home, "config.json")), false);
    });
  } finally { await s.close(); }
});

test("pair --json without --v1 is unchanged: a server without peer_channel fails by name, nothing is filed", { timeout: 30_000 }, async () => {
  const s = await fakeServer();
  try {
    await withHome(async (home) => {
      const r = await run(home, "pair", "--json", "--server", s.url);
      assert.deepEqual([r.code, r.lines.length, r.lines[0]?.state, r.lines[0]?.code], [1, 1, "failed", "server_flag_off"]);
      assert.equal(s.hits.includes("POST /connector/v1/pairing"), false);
      assert.equal(existsSync(join(home, "config.json")), false);
    });
  } finally { await s.close(); }
});

test("pair status --json tells peer_channel from v1; stale keys never turn a v1 connection into peer-channel", { timeout: 30_000 }, async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://x", token: "t" }));
    assert.deepEqual((await run(home, "pair", "status", "--json")).lines, [{ schema: "approval-box.pair-status.v1", paired: false, server: "http://x" }]);
    putKeys(home);
    assert.deepEqual((await run(home, "pair", "status", "--json")).lines, [{ schema: "approval-box.pair-status.v1", paired: true, server: "http://x", path: "peer_channel" }]);
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://x", token: "t", path: "v1" }));
    assert.deepEqual((await run(home, "pair", "status", "--json")).lines, [{ schema: "approval-box.pair-status.v1", paired: true, server: "http://x", path: "v1" }]);
  });
});

test("a v1 connection: the daemon and the MCP take the /connector/v1 path even with old keys (no flag lookup, no mode wait)", { timeout: 30_000 }, async () => {
  await withHome(async (home) => {
    const before = process.env.APPROVAL_BOX_HOME;
    process.env.APPROVAL_BOX_HOME = home;
    try {
      putKeys(home);
      writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://127.0.0.1:1", token: "t" }));
      assert.equal(pcPrepared(), true);
      writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://127.0.0.1:1", token: "t", path: "v1" }));
      assert.equal(pcPrepared(), false);
      assert.equal(await startDaemonPeerChannel({ server: "http://127.0.0.1:1", token: "t" }, () => {}), undefined); // returns before any network call
      assert.equal(readMode(), null);
      assert.equal(await useLocalApi(), false); // MCP: Api(config), not the daemon's local socket
    } finally {
      if (before === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = before;
    }
  });
});
