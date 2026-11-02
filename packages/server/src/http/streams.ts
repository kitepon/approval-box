import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Services } from "./types.ts";
import type { UserEvent } from "../events.ts";

const HEARTBEAT_MS = 25_000;
/** 次の知らせ・切断・停止の合図か、ping の時刻まで待つ。起こされたら時計を片付ける。 */
function untilWake(shutdown: AbortSignal | undefined, arm: (resume: () => void) => void) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HEARTBEAT_MS);
    const resume = () => { clearTimeout(timer); resolve(); };
    arm(resume);
    if (shutdown?.aborted) resume();
  });
}

export function userEvents(c: Context, services: Services, userId: string) {
  const { events } = services;
  const last = Number(c.req.header("last-event-id") ?? c.req.query("last_event_id") ?? 0) || 0;
  return streamSSE(c, async (stream) => {
    const queue: UserEvent[] = events.since(userId, last);
    let wake: (() => void) | null = null;
    const unsubscribe = events.subscribe(userId, (event) => { queue.push(event); wake?.(); });
    stream.onAbort(() => { unsubscribe(); wake?.(); });
    const stop = () => wake?.();
    services.shutdown?.addEventListener("abort", stop, { once: true });
    let sent = last;
    while (!stream.aborted && !services.shutdown?.aborted) {
      while (queue.length) {
        const event = queue.shift()!;
        if (event.id <= sent) continue;
        sent = event.id;
        await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event.data) });
      }
      await untilWake(services.shutdown, (resume) => { wake = resume; });
      wake = null;
      if (!queue.length && !stream.aborted && !services.shutdown?.aborted) await stream.write(": ping\n\n");
    }
    // 停止の合図では、流れを正しく閉じて返す。利用側は切断でなく正常終了として再接続できる。
    services.shutdown?.removeEventListener("abort", stop);
    unsubscribe();
  });
}

export function connectorEvents(c: Context, services: Services, connectionId: string) {
  const { events } = services;
  return streamSSE(c, async (stream) => {
    let pending = true;
    let wake: (() => void) | null = null;
    const unsubscribe = events.subscribeConnection(connectionId, () => { pending = true; wake?.(); });
    stream.onAbort(() => { unsubscribe(); wake?.(); });
    const stop = () => wake?.();
    services.shutdown?.addEventListener("abort", stop, { once: true });
    while (!stream.aborted && !services.shutdown?.aborted) {
      if (pending) {
        pending = false;
        await stream.writeSSE({ event: "deliveries", data: "{}" });
      }
      await untilWake(services.shutdown, (resume) => { wake = resume; });
      wake = null;
      if (!pending && !stream.aborted && !services.shutdown?.aborted) await stream.write(": ping\n\n");
    }
    services.shutdown?.removeEventListener("abort", stop);
    unsubscribe();
  });
}
