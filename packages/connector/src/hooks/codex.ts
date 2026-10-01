// Codexの同期hook（PostToolUse・Stop）。決裁箱の答えだけを作業中のturnへ取り込む。本体はaiterm-steer-delivery。
import { runCodexHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "../profile.ts";
await runCodexHookMain(PROFILE, process.argv[2]);
