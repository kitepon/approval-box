// 結び直し（peer-channel 契約 0.5.3、c8c）: ペアリング済みの接続に、新しい鍵を結ぶ。製品のペアリングはやり直さない。
// QRは PC1PAIR:: （ペアリングのコードが空）。鍵は結べてから置き換え、outbox の申請は残して、新しい登録を信頼の起点にする。
// 結べなければ前の鍵のまま（名前付きで伝える）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startPairingBinding } from "@kitepon/peer-channel/pairing";
import { Api } from "./api.ts";
import { writeJsonFile } from "./config.ts";
import { admissionFile, pcRoot, serverOffersPeerChannel } from "./pc-mode.ts";
import { newKeys, saveKeys } from "./pc-keys.ts";

export async function rebindKeys(config: { server: string; token: string }, o: {
  /** QRの文と入力用の16文字を見せる。 */
  show(qrText: string, typedCode: string): void | Promise<void>;
  /** 鍵を置き換えた後、デーモンを起こし直す（新しい鍵で動かす）。 */
  restart(): Promise<void>;
  timeoutMs?: number;
}) {
  if (!(await serverOffersPeerChannel(config.server))) throw Object.assign(new Error("このサーバーは peer-channel を出していません。鍵の結び直しは要りません。"), { code: "server_flag_off" });
  const info = await new Api(config).call<{ connection_id: string; me: { user_id: string } }>("GET", "/connection");
  const fresh = await newKeys();
  const binding = startPairingBinding(fresh.keys);
  await o.show(binding.qrText(""), binding.typedCode);
  const admission = await binding.complete({ server: { url: config.server, headers: { authorization: `Bearer ${config.token}` } }, account: info.me.user_id, connectionId: info.connection_id, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  // 結べた: 鍵を置き換え、新しい登録を起点にする。outbox の申請と墓標は残す（端末へは新しい鍵で送り直す）。
  saveKeys(fresh.saved);
  writeJsonFile(admissionFile(), admission);
  const state = join(pcRoot(), "connector", "connector-state.json");
  if (existsSync(state)) {
    const saved = JSON.parse(readFileSync(state, "utf8")) as { registry?: unknown };
    delete saved.registry;
    writeJsonFile(state, saved);
  }
  await o.restart();
}
