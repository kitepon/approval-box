import * as steer from "aiterm-steer-delivery";
import { PROFILE } from "./profile.ts";

type CodexParent = { thread_id: string; codex_home: string };
export type CodexProvider = {
  submit(parent: CodexParent, deliveryId: string, text: string): Promise<{ queued_submission_id: string | null }>;
  state(parent: CodexParent, deliveryId: string): Promise<"sending" | "unknown" | null>;
};
const provider: CodexProvider = {
  submit: (parent, id, text) => steer.submitCodexParentAnswerViaAiterm(parent, id, text),
  state: (parent, id) => steer.codexDeliveryStateViaAiterm(parent, id),
};

/** 旧channel.v1もそのまま読み、CodexだけAiterm所有の共通配送へ渡す。 */
export async function sendChannelAnswer(channelId: string, deliveryId: string, text: string, codex = provider) {
  if (steer.channelClosed(PROFILE, channelId)) throw Object.assign(new Error("申請を出したAIの会話が終わっています"), { closed: true });
  const channel = steer.readChannel(PROFILE, channelId);
  if (channel.kind !== "codex") return steer.sendToChannel(PROFILE, channelId, deliveryId, text);
  if (!channel.codex) throw new steer.CodexDeliveryError("CODEX_PARENT_ID_UNAVAILABLE", "channelに元のCodex会話がありません");
  const result = await codex.submit(channel.codex, deliveryId, text);
  return { state: "submitted" as const, queued_submission_id: result.queued_submission_id };
}

export async function channelAnswerState(channelId: string, deliveryId: string, codex = provider) {
  const channel = steer.readChannel(PROFILE, channelId);
  if (channel.kind !== "codex") return steer.channelDeliveryState(PROFILE, channelId, deliveryId);
  if (!channel.codex) throw new steer.CodexDeliveryError("CODEX_PARENT_ID_UNAVAILABLE", "channelに元のCodex会話がありません");
  return codex.state(channel.codex, deliveryId);
}
