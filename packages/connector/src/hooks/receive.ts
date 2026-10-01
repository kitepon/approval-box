// Cursorのidle時とGrokで、AIが背景で起動する受信process。答えを1つ受け取ってJSONで出して終わる。
// 結果のnext_wait_processを同じように起動すると、次の答えも受け取れる。本体はaiterm-steer-delivery。
import { runChannelReceiveMain } from "aiterm-steer-delivery";
import { PROFILE } from "../profile.ts";
await runChannelReceiveMain(PROFILE);
