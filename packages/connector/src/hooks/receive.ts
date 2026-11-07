// Cursor・Grokで、AIが背景で起動する受信process。答えを受け取ってJSONで出して終わる。
// 結果のnext_wait_processを同じように起動すると、次の答えも受け取れる。本体はaiterm-steer-delivery。
import { runChannelReceiveMain } from "aiterm-steer-delivery";
import { recordBackgroundReceiver } from "../background-receiver.ts";
import { PROFILE } from "../profile.ts";
// 配送デーモンがこの受信の有無を見る。記録できなくても受信は続ける（記録が無い本文は5分で配送失敗になる）。
const channelId = process.argv[2] === "--channel" ? process.argv[3] : undefined;
if (channelId) { try { recordBackgroundReceiver(channelId); } catch { /* 記録できない */ } }
await runChannelReceiveMain(PROFILE);
