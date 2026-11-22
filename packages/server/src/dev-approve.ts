#!/usr/bin/env node
// 研究室用の「承認する端末」（c8h）。`npm run dev:approve -- '<PC1PAIR text>'`。docs/architecture/peer-channel-adoption.md の 8。
// 手元のdevサーバー（ループバックだけ）で、電話もオーナーも無しに、コネクタの peer-channel ペアリング（契約 5.4）を一度通すための偽の端末。
// 試験・本番のサーバーには何もしない: DEV_URL が assertLoopback を通らなければ動かない。鍵も通行証も出力しない。
import { createECDH } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  b64url, fromHex, fromJson, parseBody, parseQrText, sealKeyFromScalar, signingKeyFromScalar, signSnapshot, snapshotHash, toJson,
  type DeviceEntry, type SignedSnapshotJson, type SnapshotBody,
} from "@kitepon/peer-channel";
import { TestDevice } from "@kitepon/peer-channel/testing";
import { assertLoopback } from "./dev.ts";

export type LabApproveOptions = { text: string; url?: string; dataDir?: string; subject?: string };
type Saved = { v: 1; sig_d: string; seal_d: string; seal_pub: string; account?: string; snapshot?: SignedSnapshotJson };

/** 失敗は名前（code）つき。ログにも出力にも、鍵と通行証は入れない。 */
class LabError extends Error {
  code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

const EMPTY_ENTRY = { key_id: "", sig_pub: "", seal_pub: "", connection_id: "", added_at: 0, added_by: "" };

export async function labApprove(o: LabApproveOptions): Promise<{ approved: true; connection_id: string | null; k: string }> {
  const base = assertLoopback(o.url ?? "http://127.0.0.1:8788").origin;
  const subject = o.subject ?? "dev-person";
  const dataDir = resolve(o.dataDir ?? ".dev-data");
  const qr = parseQrText(o.text);
  if (qr?.kind !== "pair") throw new LabError("bad_text", "the text is not a PC1PAIR text");

  const call = async (method: string, path: string, body?: unknown, pass?: string) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(pass ? { authorization: `Bearer ${pass}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, json };
  };
  const need = async (step: string, p: Promise<{ status: number; json: Record<string, unknown> }>, ok: number[] = [200]) => {
    const r = await p;
    if (!ok.includes(r.status)) throw new LabError(`${step}_${r.status}`, `${step} answered ${r.status}${typeof r.json.error === "string" ? ` (${r.json.error})` : ""}`);
    return r.json;
  };

  // a. the fake sign-in (section 8)
  const { nonce } = await need("nonce", call("POST", "/auth/v1/signin/nonce", {})) as { nonce: string };
  const { id_token } = await need("id_token", call("POST", "/dev/id-token", { provider: "apple", nonce, sub: subject })) as { id_token: string };
  const { pass, k } = await need("signin", call("POST", "/auth/v1/signin", { provider: "apple", idToken: id_token, nonce })) as { pass: string; k: string };

  // b. this approver's own device keys, kept beside the dev database
  const file = join(dataDir, "lab-approver.json");
  let saved: Saved;
  if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
  else {
    const sig = createECDH("prime256v1"); sig.generateKeys();
    const seal = createECDH("prime256v1"); seal.generateKeys();
    saved = { v: 1, sig_d: sig.getPrivateKey("hex"), seal_d: seal.getPrivateKey("hex"), seal_pub: seal.getPublicKey("hex", "uncompressed") };
  }
  const save = () => { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 }); };
  const sign = signingKeyFromScalar(fromHex(saved.sig_d));
  const seal = await sealKeyFromScalar(fromHex(saved.seal_d), fromHex(saved.seal_pub));

  // c. the registry: a genesis the first time (or for a new account), the saved head after that
  if (!saved.snapshot || saved.account !== k) {
    const now = Date.now();
    const me: DeviceEntry = { key_id: b64url(sign.id), sig_pub: b64url(sign.pub), seal_pub: b64url(seal.pub), platform: "ios", protection: "hardware", added_at: now - 1000, added_by: b64url(sign.id) };
    const body: SnapshotBody = { v: "pc1-registry", account: k, version: 1, prev: [], created_at: now, devices: [me], connectors: [], removed: [] };
    const genesis = toJson(signSnapshot(body, sign));
    await need("registry", call("PUT", "/pc/v1/registry", genesis, pass), [204]);
    saved = { ...saved, account: k, snapshot: genesis };
    save();
  }
  const head = fromJson(saved.snapshot!);
  const headBody = parseBody(head.body);
  if (!headBody) throw new LabError("registry_unreadable", "lab-approver.json holds a snapshot that is not a registry");

  // d. the product's claim (an empty code is a re-binding: the connection already exists)
  if (qr.pairingCode) {
    const found = await need("lookup", call("GET", `/v1/pairing/lookup?code=${encodeURIComponent(qr.pairingCode)}`, undefined, pass)) as { pairing_id: string; client?: string };
    await need("claim", call("POST", `/v1/pairing/${found.pairing_id}/claim`, found.client ? { confirm_client: found.client } : {}, pass));
  }

  // e. approve the connector's keys (contract 5.4)
  const device = new TestDevice({ url: base, headers: { authorization: `Bearer ${pass}` } }, sign, seal, EMPTY_ENTRY);
  try {
    await device.open();
    const uploaded = await device.approveConnector({ text: o.text, registry: { body: headBody, hash: snapshotHash(head) } });
    saved = { ...saved, snapshot: uploaded };
    save();
    const added = parseBody(fromJson(uploaded).body)?.connectors.reduce<{ connection_id: string; added_at: number } | null>((a, c) => (!a || c.added_at >= a.added_at ? c : a), null);
    return { approved: true, connection_id: added?.connection_id ?? null, k };
  } catch (error) {
    throw error instanceof LabError ? error : new LabError((error as { code?: string }).code ?? "approve_failed", (error as Error).message);
  } finally { device.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  labApprove({ text: process.argv[2] ?? "", ...(env.DEV_URL ? { url: env.DEV_URL } : {}), ...(env.DEV_DATA ? { dataDir: env.DEV_DATA } : {}), ...(env.DEV_SUBJECT ? { subject: env.DEV_SUBJECT } : {}) })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); }) // node-datachannel keeps the loop alive otherwise
    .catch((e: { code?: string; message: string }) => { console.log(JSON.stringify({ approved: false, error: e.code ?? "approve_failed" })); console.error(`approval-box-dev-approve: ${e.message}`); process.exit(1); });
}
