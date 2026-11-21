// peer-channel の道を使うかの判断（ネイティブのモジュールを読まない、MCPとデーモンの両方から使う小さな所）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./profile.ts";

export const pcRoot = () => join(stateRoot(), "pc");

export const admissionFile = (root = pcRoot()) => join(root, "admission.json");
export const modeFile = (root = pcRoot()) => join(root, "mode.json");

/** 鍵と、ペアリング（契約 5.4）で受け取った登録（outbox の状態、またはまだ取り込んでいない admission）が手元にある。 */
export const pcPrepared = (root = pcRoot()) => existsSync(join(root, "keys.json"))
  && (existsSync(join(root, "connector", "connector-state.json")) || existsSync(admissionFile(root)));

/** サーバーが peer-channel を置いているか（GET /v1/auth/config の peer_channel）。読めなければ投げる（黙って今の道にしない）。 */
export async function serverOffersPeerChannel(server: string): Promise<boolean> {
  const response = await fetch(`${server.replace(/\/$/, "")}/v1/auth/config`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`/v1/auth/config HTTP ${response.status}`);
  return ((await response.json()) as { peer_channel?: unknown }).peer_channel === true;
}

/** デーモンが決めた道（MCPはこれに従う。決めるのはデーモンだけなので、MCPとデーモンの道は食い違わない）。 */
export type Mode = { mode: "pc" | "server"; reason: string; pid: number; at: string };
export function readMode(root = pcRoot()): Mode | null {
  try { return JSON.parse(readFileSync(modeFile(root), "utf8")) as Mode; } catch { return null; }
}
