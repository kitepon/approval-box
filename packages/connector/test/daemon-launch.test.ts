import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonBootstrap, launchDaemon, windowsDaemonLaunchScript } from "../src/daemon-launch.ts";

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

test("両OS共通writerは単一の長期稼働と巨大chunkを1MiBに抑え、末尾とcallbackを保持する", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ab-daemon-log-"));
  try {
    const entry = join(cwd, "entry.mjs");
    writeFileSync(entry, `let calls=0;for(let i=0;i<12;i++)process.stderr.write('x'.repeat(300000),()=>calls++);process.stderr.write('y'.repeat(2000000));process.stderr.write('LATEST',()=>calls++);if(calls!==13)throw Error('callbacks');`);
    writeFileSync(join(cwd, "deliveries.json"), '{"state":"unknown"}');
    const script = windowsDaemonLaunchScript(process.execPath, entry, cwd, {});
    const encoded = /Buffer\.from\(''([A-Za-z0-9+/=]+)''/.exec(script)![1]!;
    for (const bootstrap of [daemonBootstrap(entry, cwd), Buffer.from(encoded, "base64").toString()]) {
      const result = spawnSync(process.execPath, ["-e", bootstrap], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const log = readFileSync(join(cwd, "daemon.log"));
      assert.equal(log.length, 1024 * 1024);
      assert.equal(log.subarray(-6).toString(), "LATEST");
      assert.ok(log.subarray(0, -6).every(byte => byte === 121));
    }
    assert.equal(readFileSync(join(cwd, "deliveries.json"), "utf8"), '{"state":"unknown"}');
    assert.deepEqual(readdirSync(cwd).sort(), ["daemon.log", "deliveries.json", "entry.mjs"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("既存巨大log・並行起動にも上限を適用し、世代やscratchを増やさない", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ab-daemon-parallel-"));
  try {
    const entry = join(cwd, "entry.mjs");
    writeFileSync(join(cwd, "daemon.log"), "old".repeat(1000000));
    writeFileSync(entry, `for(let i=0;i<20;i++)process.stderr.write('z'.repeat(170000));`);
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", daemonBootstrap(entry, cwd)], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    })));
    assert.ok(statSync(join(cwd, "daemon.log")).size <= 1024 * 1024);
    assert.deepEqual(readdirSync(cwd).sort(), ["daemon.log", "entry.mjs"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("log保存失敗は本体とcallbackを失敗させず、import失敗は上限内に記録する", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ab-daemon-failure-"));
  try {
    const entry = join(cwd, "entry.mjs");
    writeFileSync(entry, `process.stderr.write('diagnostic',()=>process.stdout.write('continued'));`);
    mkdirSync(join(cwd, "daemon.log"));
    const continued = spawnSync(process.execPath, ["-e", daemonBootstrap(entry, cwd)], { encoding: "utf8", timeout: 10000 });
    assert.equal(continued.status, 0);
    assert.equal(continued.stdout, "continued");
    assert.match(continued.stderr, /daemon log write failed/);
    rmSync(join(cwd, "daemon.log"), { recursive: true });
    const failed = spawnSync(process.execPath, ["-e", daemonBootstrap(join(cwd, "missing.mjs"), cwd)], { encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.match(readFileSync(join(cwd, "daemon.log"), "utf8"), /ERR_MODULE_NOT_FOUND/);
    assert.ok(statSync(join(cwd, "daemon.log")).size <= 1024 * 1024);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
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
