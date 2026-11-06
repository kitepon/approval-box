import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJsonFile } from "../src/config.ts";

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
    assert.throws(() => writeJsonFile(file, { next: true }), (error: NodeJS.ErrnoException) => {
      assert.equal(error.syscall, "rename");
      return true;
    });
    assert.equal(readFileSync(join(file, "original"), "utf8"), "preserved");
    assert.equal(readFileSync(`${file}.other.tmp`, "utf8"), "foreign");
    assert.deepEqual(readdirSync(root).sort(), ["config.json", "config.json.other.tmp"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
