// Cursorの公式hook。tool結果の印で会話へ結び、作業中は次のtool返りへ答えを差し込む。本体はaiterm-steer-delivery。
import { runCursorHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "../profile.ts";
await runCursorHookMain(PROFILE);
