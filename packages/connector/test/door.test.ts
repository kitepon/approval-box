import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerError } from "../src/api.ts";
import { doorProof, provenDoor } from "../src/door.ts";
import { LocalApi } from "../src/local-api.ts";

const KEY = "a".repeat(64);
// A door that proves itself on its own address (proof: true), a stranger that answers anything (proof: false). Lines records what each received.
function door(path: string, proof: boolean, lines: string[]): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end); buffer = "";
      lines.push(line);
      const message = JSON.parse(line) as { bellteam_door?: string; nonce?: string };
      if (message.bellteam_door === "hello") socket.end(`${JSON.stringify({ ok: true, proof: proof ? doorProof(KEY, message.nonce!, path) : "0".repeat(64) })}\n`);
      else socket.end(`${JSON.stringify({ ok: true, result: { items: [] } })}\n`);
    });
  });
  return new Promise((ok) => server.listen(path, () => ok(server)));
}

test("Windowsの入口: アドレスfileの入口を名乗りで確かめてから送り、名乗れない相手には挨拶しか送らない（Delta P6）", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-door-"));
  const servers: Server[] = [];
  try {
    mkdirSync(join(home, ".bellteam"));
    const real = join(home, "real.sock"), squatter = join(home, "default.sock");
    const realLines: string[] = [], squatLines: string[] = [];
    servers.push(await door(real, true, realLines), await door(squatter, false, squatLines));
    // no key: nothing is sent anywhere
    await assert.rejects(provenDoor(squatter, home), (e: unknown) => e instanceof ServerError && e.code === "door_unproven");
    assert.deepEqual(squatLines, []);
    writeFileSync(join(home, ".bellteam", "approval-box-door.key"), KEY);
    // the default name is squatted and there is no address file: the stranger gets only the hello
    await assert.rejects(provenDoor(squatter, home), (e: unknown) => e instanceof ServerError && e.code === "door_unproven");
    assert.equal(squatLines.length, 1);
    assert.match(squatLines[0]!, /^\{"bellteam_door":"hello","nonce":"[0-9a-f]{32}"\}$/);
    // the door wrote its fresh address: read first, proved, then the request goes there
    writeFileSync(join(home, ".bellteam", "approval-box-door.addr"), `${real}\n`);
    assert.equal(await provenDoor(squatter, home), real);
    const api = new LocalApi(squatter, 1000, () => provenDoor(squatter, home));
    assert.deepEqual(await api.call("GET", "/decisions"), { items: [] });
    assert.ok(realLines.some((l) => l.includes('"/decisions"')));
    assert.ok(squatLines.every((l) => l.includes("bellteam_door")), "the stranger never saw a request");
    // a stale address file (nothing listens there) falls back to the configured name
    writeFileSync(join(home, ".bellteam", "approval-box-door.addr"), join(home, "gone.sock"));
    assert.equal(await provenDoor(real, home), real);
    // nothing listens anywhere: ENOENT, so the caller waits as for a starting daemon
    await assert.rejects(provenDoor(join(home, "none.sock"), home), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  } finally {
    for (const s of servers) s.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("POSIX の use-hosted は名乗りを求めない（0700 の中の 0600 のソケット）", () => {
  const posix = LocalApi.hosted("/tmp/x.sock", "linux") as unknown as { resolve?: unknown };
  const windows = LocalApi.hosted("\\\\.\\pipe\\x", "win32") as unknown as { resolve?: unknown };
  assert.equal(posix.resolve, undefined);
  assert.equal(typeof windows.resolve, "function");
});
