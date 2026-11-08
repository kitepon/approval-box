import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renameWithRetry, writeJsonFile } from "../src/config.ts";

test("設定保存は正常fileだけを残し、rename失敗は元対象と元エラーを保って専有tempを回収する", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-config-cleanup-"));
  try {
    const file = join(root, "config.json");
    writeJsonFile(file, { state: "unknown" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { state: "unknown" });
    assert.deepEqual(readdirSync(root), ["config.json"]);
    rmSync(file); mkdirSync(file);
    writeFileSync(join(file, "original"), "preserved");
    writeFileSync(`${file}.other.tmp`, "foreign");
    assert.throws(() => writeJsonFile(file, { next: true }, { discardTemporaryOnError: true }), (error: NodeJS.ErrnoException) => {
      assert.equal(error.syscall, "rename");
      return true;
    });
    assert.equal(readFileSync(join(file, "original"), "utf8"), "preserved");
    assert.equal(readFileSync(`${file}.other.tmp`, "utf8"), "foreign");
    assert.deepEqual(readdirSync(root).sort(), ["config.json", "config.json.other.tmp"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("一度だけ取得する資格と不明状態は、失敗時の唯一のtempを既定で保持する", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-config-recovery-"));
  try {
    const file = join(root, "config.json");
    mkdirSync(file);
    const value = { token: "one-time-fixture", delivery: "unknown" };
    assert.throws(() => writeJsonFile(file, value), (error: NodeJS.ErrnoException) => error.syscall === "rename");
    assert.deepEqual(JSON.parse(readFileSync(`${file}.${process.pid}.tmp`, "utf8")), value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windowsの置き換え拒否（EPERM/EACCES/EBUSY）は短く待って繰り返し、他の失敗や他のOSは即時に伝える", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code, syscall: "rename" });
  const waits: number[] = [];
  let calls = 0;
  const flaky = (fails: number, code = "EPERM") => () => { if (++calls <= fails) throw busy(code); };
  renameWithRetry("a", "b", flaky(2), true, ms => waits.push(ms));
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
  calls = 0; waits.length = 0;
  renameWithRetry("a", "b", flaky(1, "EBUSY"), true, ms => waits.push(ms));
  assert.equal(calls, 2);
  // 他のOSでは繰り返さない（Linux/macOSのrenameは開いているfileでも置き換えられる）
  calls = 0;
  assert.throws(() => renameWithRetry("a", "b", flaky(1), false, () => assert.fail("waited")), /EPERM/);
  assert.equal(calls, 1);
  // 繰り返しても拒否されたら、ロックと断定せず対象と失敗を伝える
  calls = 0; waits.length = 0;
  assert.throws(() => renameWithRetry("a", "C:\\u\\.claude.json", flaky(99), true, ms => waits.push(ms)), (error: NodeJS.ErrnoException) => error.code === "EPERM" && error.message.includes(".claude.json の置き換えが拒否されました"));
  assert.equal(calls, 30);
  assert.equal(waits.length, 29);
  // ENOENTのような別の失敗は繰り返さない
  calls = 0;
  assert.throws(() => renameWithRetry("a", "b", flaky(5, "ENOENT"), true, () => assert.fail("waited")), /ENOENT/);
  assert.equal(calls, 1);
});
