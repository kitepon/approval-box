// peer-channel の接続の鍵（署名と封の P-256）。契約 3.2 の「OSの保管庫が無ければ接続の状態の置き場の 0600 のファイル」。
// 一度作って state/pc/keys.json に置く。鍵は外へ出さない（公開の半分だけが登録に入る）。
import { createECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, sealKeyFromScalar, signingKeyFromScalar, type SealKey, type SigningKey } from "@kitepon/peer-channel";
import { writeJsonFile } from "./config.ts";
import { pcRoot } from "./pc-mode.ts";
export const keysFile = () => join(pcRoot(), "keys.json");

type Saved = { v: 1; sig_d: string; seal_d: string; seal_pub: string };

/** 鍵を読む。無ければ作って 0600 で保存する。 */
export async function loadOrCreateKeys(file = keysFile()): Promise<{ sign: SigningKey; seal: SealKey }> {
  let saved: Saved;
  if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
  else {
    const sig = createECDH("prime256v1"); sig.generateKeys();
    const seal = createECDH("prime256v1"); seal.generateKeys();
    saved = { v: 1, sig_d: sig.getPrivateKey("hex"), seal_d: seal.getPrivateKey("hex"), seal_pub: seal.getPublicKey("hex", "uncompressed") };
    writeJsonFile(file, saved, { discardTemporaryOnError: true });
  }
  return { sign: signingKeyFromScalar(fromHex(saved.sig_d)), seal: await sealKeyFromScalar(fromHex(saved.seal_d), fromHex(saved.seal_pub)) };
}

