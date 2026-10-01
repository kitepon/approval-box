import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * AIが毎回読む全体の指示へ足す一節。MCPの説明文だけでは、AIはチャットで聞く癖を優先する。
 * 禁止の形にしない（クオの裁定）。チャットで聞くのは止めず、Approval Boxでも申請するよう勧める。
 */
export const INSTRUCTION_TEXT = "ユーザーの判断が必要なときは、決裁システムである Approval Box の request_decision でも申請する。これを使えばユーザーが申請に気づきやすいので、強く推奨する。";

const START = "<!-- approval-box:start -->";
const END = "<!-- approval-box:end -->";
const BLOCK = `${START}\n## Approval Box\n\n${INSTRUCTION_TEXT}\n${END}\n`;
const PATTERN = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`, "g");

export function hasInstructions(file: string): boolean {
  return existsSync(file) && readFileSync(file, "utf8").includes(START);
}

/** 印で囲んだ一節を書く。前に書いた一節は置き換え、利用者が書いた所には触れない。 */
export function writeInstructions(file: string) {
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(PATTERN, "\n").trimEnd() : "";
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, current ? `${current}\n\n${BLOCK}` : BLOCK);
}

export function removeInstructions(file: string) {
  if (!hasInstructions(file)) return;
  const rest = readFileSync(file, "utf8").replace(PATTERN, "\n").trimEnd();
  writeFileSync(file, rest ? `${rest}\n` : "");
}
