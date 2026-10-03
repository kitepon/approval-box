import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTRUCTION_TEXT, hasInstructions, hasInstructionsInDir, managedElsewhere, removeInstructions, writeInstructions } from "../src/instructions.ts";

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

test("symlinkの先（dotagentsの生成物など）には書かず、前の版が書いた区画は外せる", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-inst-"));
  const source = join(dir, "generated.md");
  const link = join(dir, "CLAUDE.md");
  writeFileSync(source, "# 生成物\n");
  symlinkSync(source, link);
  assert.equal(managedElsewhere(link), source);
  assert.equal(writeInstructions(link), "managed_elsewhere");
  assert.equal(readFileSync(source, "utf8"), "# 生成物\n");
  writeFileSync(source, "# 生成物\n\n<!-- approval-box:start -->\n## Approval Box\n\nold\n<!-- approval-box:end -->\n");
  removeInstructions(link);
  assert.equal(readFileSync(source, "utf8"), "# 生成物\n");
  assert.ok(lstatSync(link).isSymbolicLink());
});

test("管理元が自分の言葉で書いた同じ趣旨の文も一節とみなし、外す時は触れない", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ab-inst-")), "AGENTS.md");
  const text = "- オーナーの判断が必要なときは、ask_owner やチャットで聞くのに加えて、Approval Box の `request_decision` でも申請する。\n";
  writeFileSync(file, text);
  assert.ok(hasInstructions(file));
  removeInstructions(file);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("Claude Code の @取り込みを1段たどって、管理元の文を見つける", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-inst-"));
  writeFileSync(join(dir, "AGENTS.md"), "- 承認が要る時は Approval Box の request_decision でも申請する。\n");
  writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
  assert.ok(hasInstructions(join(dir, "CLAUDE.md")));
  writeFileSync(join(dir, "AGENTS.md"), "- 別の話\n");
  assert.ok(!hasInstructions(join(dir, "CLAUDE.md")));
});

test("規範の置き場（rules）にある同じ趣旨の文を見つける", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-inst-"));
  assert.ok(!hasInstructionsInDir(join(dir, "none")));
  writeFileSync(join(dir, "other.md"), "- 別の話\n");
  assert.ok(!hasInstructionsInDir(dir));
  writeFileSync(join(dir, "factory.mdc"), "- 承認が必要なときは Approval Box の request_decision でも申請する。\n");
  assert.ok(hasInstructionsInDir(dir));
});
