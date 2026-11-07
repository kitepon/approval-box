// 背景channel（Grok等）の受信process。AIが背景で起こした受信が居るかを配送デーモンが見られるよう、
// 受信の起動時に自分のpidと起動時刻を記録する。記録が無い・processが居ない間に届いた本文は、誰も出せない。
import * as steer from "aiterm-steer-delivery";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "./config.ts";
import { PROFILE } from "./profile.ts";

type Profile = Parameters<typeof steer.readChannel>[0];
type Record_ = { pid: number; started_identity: string; at: string };

export const receiverFile = (channelId: string, profile: Profile = PROFILE) => join(profile.state_root(), "background-receivers", `${channelId}.json`);

/** 受信の起動時に呼ぶ。同じchannelの受信は最後に起きた一つだけ記録する（shortcut: 複数の受信が同時に待つ形は無い。出たら一覧へ）。 */
export function recordBackgroundReceiver(channelId: string, profile: Profile = PROFILE, pid = process.pid, identity = steer.readProcessIdentities([pid])[0]?.started_identity) {
  if (!identity) return false;
  writeJsonFile(receiverFile(channelId, profile), { pid, started_identity: identity, at: new Date().toISOString() } satisfies Record_);
  return true;
}

/** 記録した受信processが今も居るか。記録が無ければ居ない。 */
export function backgroundReceiverRunning(channelId: string, profile: Profile = PROFILE, running: (pid: number, startedIdentity: string) => boolean = steer.processIsRunning): boolean {
  const file = receiverFile(channelId, profile);
  if (!existsSync(file)) return false;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as Partial<Record_>;
    return typeof record.pid === "number" && typeof record.started_identity === "string" && running(record.pid, record.started_identity);
  } catch { return false; }
}
