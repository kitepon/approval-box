// BellTeam's door on a Windows host (BellTeam terminals README "Door identity", Krust #2630/#2634; Delta's P6, #2636).
// Any local account may create a pipe under the door's predictable name, so the name is never trusted: the use-hosted relay
// reads the door's own address file first, falls back to the configured --socket, and sends only the hello to an address until
// it proves itself with the host user's door key. A stranger gets the hello and nothing else (no request, no decision).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ServerError } from "./api.ts";

const HELLO_MS = 2000;
const KEY = /^[0-9a-f]{64}$/;
const bellteamFile = (name: string, home: string) => join(home, ".bellteam", name);

export type Proof = "proved" | "absent" | "stranger";

/** The door's proof: HMAC-SHA256 under the key text of "<nonce>\n<the address it listens on>" (so a relayed proof fits no other address). */
export const doorProof = (key: string, nonce: string, address: string) => createHmac("sha256", key).update(`${nonce}\n${address}`).digest("hex");

/** Sends only the hello. 'absent' = nothing listens; 'stranger' = no valid proof in time (another account's pipe, an old door, a hang). */
export const proveDoor = (address: string, key: string, timeoutMs = HELLO_MS) => new Promise<Proof>((resolve) => {
  const nonce = randomBytes(16).toString("hex");
  let reply = "", done = false;
  const socket = createConnection(address);
  const finish = (result: Proof) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
  const timer = setTimeout(() => finish("stranger"), timeoutMs);
  socket.setEncoding("utf8");
  socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "absent" : "stranger"));
  socket.once("connect", () => socket.write(`{"bellteam_door":"hello","nonce":"${nonce}"}\n`));
  socket.on("data", (chunk: string) => {
    reply += chunk;
    if (!reply.includes("\n")) { if (reply.length > 4096) finish("stranger"); return; }
    let proof: unknown;
    try { proof = (JSON.parse(reply.slice(0, reply.indexOf("\n"))) as { proof?: unknown }).proof; } catch { /* not a door */ }
    const want = Buffer.from(doorProof(key, nonce, address)), got = Buffer.from(typeof proof === "string" ? proof : "");
    finish(want.length === got.length && timingSafeEqual(want, got) ? "proved" : "stranger");
  });
  socket.once("end", () => finish("stranger"));
});

const unproven = (detail: string) => new ServerError(503, "door_unproven", `BellTeamの決裁箱の入口を確かめられません（${detail}）。席を起動し直すと入口が立ち直ります。何も送っていません。`, {});

/** The address of this user's proven door: the address file first, then the configured socket. Nothing listening reads as ENOENT, so the caller waits as for a starting daemon. */
export async function provenDoor(configured: string, home = homedir(), prove = proveDoor): Promise<string> {
  let key: string | undefined;
  try { const text = readFileSync(bellteamFile("approval-box-door.key", home), "utf8").trim(); if (KEY.test(text)) key = text; } catch { /* none */ }
  if (!key) throw unproven("~/.bellteam/approval-box-door.key がありません");
  let written: string | undefined;
  try { written = readFileSync(bellteamFile("approval-box-door.addr", home), "utf8").trim() || undefined; } catch { /* none: the default name */ }
  let stranger = false;
  for (const address of [...new Set([written, configured].filter((a): a is string => !!a))]) {
    const proof = await prove(address, key);
    if (proof === "proved") return address;
    if (proof === "stranger") stranger = true;
  }
  if (stranger) throw unproven("答えた相手が鍵で名乗れませんでした");
  throw Object.assign(new Error("ENOENT: no door"), { code: "ENOENT" });
}
