import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDaemon, windowsDaemonLaunchScript } from "../src/daemon-launch.ts";

test("Windows常駐adapterは隔離HOMEとCLI探索だけを保持し秘密環境を転送しない", () => {
  const script = windowsDaemonLaunchScript("C:\\Program Files\\nodejs\\node.exe", "C:\\使用者's & $env:X\\cli.mjs", "C:\\状態's\\state", { APPROVAL_BOX_HOME: "C:\\隔離 & '試験", PATH: "C:\\道具", OPENAI_API_KEY: "do-not-forward", TOKEN: "secret-token" });
  const encoded = /Buffer\.from\(''([A-Za-z0-9+/=]+)''/.exec(script)?.[1];
  assert.ok(encoded);
  const bootstrap = Buffer.from(encoded, "base64").toString();
  assert.ok(bootstrap.includes(JSON.stringify("C:\\使用者's & $env:X\\cli.mjs")));
  assert.ok(bootstrap.includes(JSON.stringify("C:\\隔離 & '試験")));
  assert.ok(bootstrap.includes('"PATH":"C:\\\\道具"'));
  assert.ok(!bootstrap.includes("do-not-forward") && !bootstrap.includes("secret-token"));
  assert.ok(script.includes("C:\\状態''s\\state"));
  assert.ok(script.includes("$result.ReturnValue -ne 0"));
});

test("起動先のnodeが無い時、呼び出した側のprocessを落とさず、名前を付けて記録する", { skip: process.platform === "win32" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ab-daemon-launch-"));
  try {
    const missing = join(cwd, "no-such-node");
    launchDaemon(missing, join(cwd, "cli.mjs"), cwd);
    // spawnの error は後から届く。受け手が無いと、ここでこの試験のprocessが落ちる。
    let log = "";
    for (let i = 0; i < 150 && !log.includes("DAEMON_LAUNCH_FAILED"); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      log = readFileSync(join(cwd, "daemon.log"), "utf8");
    }
    assert.match(log, /DAEMON_LAUNCH_FAILED/);
    assert.ok(log.includes(missing));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
