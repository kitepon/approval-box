// 再開に使う claude の場所。素の端末のPATHに頼らず、試験のPATHで決める。
// 見つからない時は、PATHへ黙って任せず、原因を付けて止める。
import { execFileSync } from "node:child_process";

export function claudeBinaryForShell(platform = process.platform, env = process.env) {
  if (platform === "win32") return "claude.cmd";
  let found;
  try {
    found = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`CLAUDE_BINARY_UNAVAILABLE: 試験のPATHに claude が見つかりません（${String(error.message).split("\n")[0]}）。PATH=${env.PATH ?? ""}`);
  }
  if (!found.startsWith("/")) throw new Error(`CLAUDE_BINARY_UNAVAILABLE: claude の場所を絶対pathで得られません（${found || "空"}）`);
  return `'${found.replace(/'/g, "'\\''")}'`;
}
