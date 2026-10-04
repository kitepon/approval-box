// hookは会話のbindだけ。回答は背景receiveがstdoutへ出して消費する。
import { bindCursorResult } from "../cursor-binding.ts";
import { PROFILE } from "../profile.ts";
try {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  await bindCursorResult(PROFILE, raw);
  process.stdout.write("{}\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "CURSOR_PARENT_HOOK_FAILED"}\n`);
  process.exitCode = 2;
}
