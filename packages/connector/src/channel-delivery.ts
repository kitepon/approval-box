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
  if (channel.kind !== "codex") {
    try {
      return await steer.sendToChannel(PROFILE, channelId, deliveryId, text);
    } catch (error) {
      // 同じ配送IDの本文がもうこのchannelにある（控えを失った後の送り直し、2つのデーモンの同時送信）。
      // 本文は足されていない。届け損ねではないので、前の本文の行方を追う。取り下げた後の送り直しは今までどおり断る。
      if ((error as { delivery_code?: string }).delivery_code !== "CHANNEL_DELIVERY_DUPLICATE") throw error;
      const state = steer.channelDeliveryState(PROFILE, channelId, deliveryId);
      if (state === null || state === "withdrawn") throw error;
      return { state: "queued" as const, queued_submission_id: null };
    }
  }
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
