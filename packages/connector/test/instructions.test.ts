import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTRUCTION_TEXT, hasInstructions, removeInstructions, writeInstructions } from "../src/instructions.ts";

test("全体の指示へ一節を足し、二度書いても一つ、外すと元に戻る", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ab-inst-")), "AGENTS.md");
  writeFileSync(file, "# 自分の指示\n\n- 既存の行\n");
  writeInstructions(file);
  writeInstructions(file);
  const text = readFileSync(file, "utf8");
  assert.equal(text.split(INSTRUCTION_TEXT).length, 2);
  assert.ok(text.startsWith("# 自分の指示\n\n- 既存の行\n\n<!-- approval-box:start -->"));
  assert.ok(hasInstructions(file));
  removeInstructions(file);
  assert.equal(readFileSync(file, "utf8"), "# 自分の指示\n\n- 既存の行\n");
  assert.ok(!hasInstructions(file));
});

test("ファイルが無ければ作る", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ab-inst-")), "sub", "CLAUDE.md");
  writeInstructions(file);
  assert.ok(readFileSync(file, "utf8").includes(INSTRUCTION_TEXT));
  removeInstructions(file);
  assert.equal(readFileSync(file, "utf8"), "");
});
