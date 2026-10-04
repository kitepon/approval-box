import { cursorHookRoot, handleCursorHook, handleCursorChannelHook, withoutBom, type ProductProfile } from "aiterm-steer-delivery";

/** hook出力の採用は保証されない。会話を結び、回答はreceiveだけが消費する。 */
export async function bindCursorResult(profile: ProductProfile, raw: string): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(withoutBom(raw)); } catch { return; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const event = parsed as Record<string, unknown>;
  const name = event.hook_event_name;
  if (name !== "afterMCPExecution" && name !== "postToolUse" && name !== "postToolUseFailure") return;
  // ライブラリのafterMCPExecutionはbindのみ。postToolUseも同じbind経路へ渡す。
  const binding = { ...event, hook_event_name: "afterMCPExecution",
    result_json: name === "afterMCPExecution" ? event.result_json : event.tool_output };
  await handleCursorHook(profile, JSON.stringify(binding), cursorHookRoot(profile));
  if (profile.channels) await handleCursorChannelHook(profile, binding, () => {
    throw new Error("CURSOR_BIND_HOOK_MUST_NOT_CONSUME_ANSWERS");
  });
}
