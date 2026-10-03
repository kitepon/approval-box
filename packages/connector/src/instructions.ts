import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * AIが毎回読む全体の指示へ足す一節。MCPの説明文だけでは、AIはチャットで聞く癖を優先する。
 * 禁止の形にしない（クオの裁定）。「判断」だけだとAIはURLを開いての承認などを外すので、承認・操作も書く（同）。
 * チャットで聞くのは止めず、Approval Boxでも申請するよう勧める。
 */
export const INSTRUCTION_TEXT = "ユーザーの判断・承認・操作が必要なときは、決裁システムである Approval Box の request_decision でも申請する。これを使えばユーザーが申請に気づきやすいので、強く推奨する。";

const START = "<!-- approval-box:start -->";
const END = "<!-- approval-box:end -->";
const BLOCK = `${START}\n## Approval Box\n\n${INSTRUCTION_TEXT}\n${END}\n`;
const PATTERN = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`, "g");

// 管理元（BellTeamの共通規範・dotagentsの正本など）が自分の言葉で書いた同じ趣旨の文も、一節があるとみなす。
const SAME_MEANING = /Approval Box\s*の\s*`?request_decision`?\s*でも申請/;

export function hasInstructions(file: string): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  if (text.includes(START) || SAME_MEANING.test(text)) return true;
  // Claude Code の「@AGENTS.md」のような取り込みは1段だけたどる（BellTeamの ~/.claude/CLAUDE.md がこの形）。
  for (const [, ref] of text.matchAll(/^@(\S+)\s*$/gm)) {
    const target = ref!.startsWith("~/") ? resolve(homedir(), ref!.slice(2)) : resolve(dirname(file), ref!);
    if (existsSync(target) && SAME_MEANING.test(readFileSync(target, "utf8"))) return true;
  }
  return false;
}

/** 管理元が配る規範の置き場（~/.grok/rules、~/.cursor/rules など）のどれかに、同じ趣旨の文があるか。 */
export function hasInstructionsInDir(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => {
      try { return SAME_MEANING.test(readFileSync(join(dir, name), "utf8")); } catch { return false; }
    });
  } catch {
    return false;
  }
}

/**
 * 指示ファイルが別の所への参照（symlink）なら、その先を返す。dotagents のように生成物へ張っている環境では、
 * 書き足すと管理元の作業ツリーが汚れて git pull が止まり、作り直すと黙って消える（ドロシーの報告 2026-10-03）。
 */
export function managedElsewhere(file: string): string | null {
  try {
    return lstatSync(file).isSymbolicLink() ? readlinkSync(file) : null;
  } catch {
    return null;
  }
}

/** 印で囲んだ一節を書く。前に書いた一節は置き換え、利用者が書いた所には触れない。symlinkの先には書かない。 */
export function writeInstructions(file: string): "written" | "managed_elsewhere" {
  if (managedElsewhere(file)) return "managed_elsewhere";
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(PATTERN, "\n").trimEnd() : "";
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, current ? `${current}\n\n${BLOCK}` : BLOCK);
  return "written";
}

/** 自分が書いた印の区画だけを外す（前の版がsymlinkの先へ書いた区画も外す）。管理元の文には触れない。 */
export function removeInstructions(file: string) {
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(START)) return;
  const rest = readFileSync(file, "utf8").replace(PATTERN, "\n").trimEnd();
  writeFileSync(file, rest ? `${rest}\n` : "");
}
