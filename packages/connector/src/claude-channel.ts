import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as steer from "aiterm-steer-delivery";

type ClaudeParent = { kind: "claude"; request_id: string; session_id: string; hook_root: string };
type Profile = Parameters<typeof steer.readChannel>[0];

/**
 * 保存してあるchannelが、今この依頼を出したClaudeのprocessに結ばれているか。
 *
 * channelは、開いた時のClaudeのprocess（pidと開始時刻の組）に結ばれる。配送部品は、会話のchannelに結んだprocessが
 * どれも居なければ、その会話の待機をやめる（本文を別の会話へ流さないため）。
 * Claudeのアプリを起動し直すと、同じ会話（session_id）が新しいprocessで再開される。session_idだけを見て古いchannelを
 * 使い回すと、待機がすぐ終わり、答えが受信箱に残ったまま会話へ届かない（2026-10-10、fox）。
 * 今のprocessは、この依頼のPreToolUse hookが記録した物を読む。読めない時・違う時は、開き直させる。
 */
export function claudeChannelIsCurrent(profile: Profile, channelId: string, parent: ClaudeParent): boolean {
  try {
    const bound = steer.readChannel(profile, channelId).claude;
    const now = JSON.parse(readFileSync(join(parent.hook_root, parent.request_id, "request.json"), "utf8")) as { parent_pid?: unknown; parent_started_identity?: unknown };
    return !!bound && bound.session_id === parent.session_id && bound.parent_pid === now.parent_pid && bound.parent_started_identity === now.parent_started_identity;
  } catch {
    return false;
  }
}
