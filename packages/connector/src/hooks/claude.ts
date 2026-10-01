// Claude Codeの公式hook（PreToolUse・PostToolUse・Stop・SessionEnd）。答えはasyncRewakeで会話へ届く。本体はaiterm-steer-delivery。
import { runClaudeHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "../profile.ts";
await runClaudeHookMain(PROFILE);
