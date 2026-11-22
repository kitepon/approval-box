#!/usr/bin/env node
// 研究室用の「承認する端末」（c8h）。`npm run dev:approve -- '<PC1PAIR text>'`、答える時は `npm run dev:answer -- [option_id]`。docs/architecture/peer-channel-adoption.md の 8。
// 手元のdevサーバー（ループバックだけ）で、電話もオーナーも無しに、コネクタの peer-channel ペアリング（契約 5.4）を一度通すための偽の端末。
// 試験・本番のサーバーには何もしない: DEV_URL が assertLoopback を通らなければ動かない。鍵も通行証も出力しない。
import { createECDH } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  b64url, fromHex, fromJson, parseBody, parseQrText, sealKeyFromScalar, signingKeyFromScalar, signSnapshot, snapshotHash, toJson,
  type ConnectorEntry, type DeviceEntry, type SignedSnapshotJson, type SnapshotBody,
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

/** a〜c: 偽のサインイン、この端末の鍵（dev データの横）、登録簿の先頭。承認と答えで同じ端末を使う。 */
async function labSession(o: { url?: string; dataDir?: string; subject?: string }) {
  const base = assertLoopback(o.url ?? "http://127.0.0.1:8788").origin;
  const subject = o.subject ?? "dev-person";
  const dataDir = resolve(o.dataDir ?? ".dev-data");

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
  const save = (next: Saved) => { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); };
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
    save(saved);
  }
  const head = fromJson(saved.snapshot!);
  const headBody = parseBody(head.body);
  if (!headBody) throw new LabError("registry_unreadable", "lab-approver.json holds a snapshot that is not a registry");
  return { base, call, need, pass, k, sign, seal, head, headBody, saved, save };
}

export async function labApprove(o: LabApproveOptions): Promise<{ approved: true; connection_id: string | null; k: string }> {
  assertLoopback(o.url ?? "http://127.0.0.1:8788"); // never the test or production server, before anything else
  const qr = parseQrText(o.text);
  if (qr?.kind !== "pair") throw new LabError("bad_text", "the text is not a PC1PAIR text");
  const { base, call, need, pass, k, sign, seal, head, headBody, saved, save } = await labSession(o);

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
    save({ ...saved, snapshot: uploaded });
    const added = parseBody(fromJson(uploaded).body)?.connectors.reduce<{ connection_id: string; added_at: number } | null>((a, c) => (!a || c.added_at >= a.added_at ? c : a), null);
    return { approved: true, connection_id: added?.connection_id ?? null, k };
  } catch (error) {
    throw error instanceof LabError ? error : new LabError((error as { code?: string }).code ?? "approve_failed", (error as Error).message);
  } finally { device.close(); }
}

export type LabAnswerOptions = { url?: string; dataDir?: string; subject?: string; option?: string; waitMs?: number };

/**
 * 研究室で「答える端末」（a514t）: 承認した同じ端末として、つないだコネクタへ電話のように電話をかけ、待っている申請に答える。
 * option が無ければ各申請の最初の選択肢。waitMs の間に次の申請が来なければ終わる。答えた申請の id と選択肢だけを返す（本文は出さない）。
 */
export async function labAnswer(o: LabAnswerOptions): Promise<{ answered: { decision_id: string; option_id: string }[] }> {
  const { base, pass, sign, seal, headBody } = await labSession(o);
  const connector = headBody.connectors.reduce<ConnectorEntry | null>((a, c) => (!a || c.added_at >= a.added_at ? c : a), null);
  if (!connector) throw new LabError("not_paired", "this lab device has approved no connector yet (run dev:approve first)");
  const device = new TestDevice({ url: base, headers: { authorization: `Bearer ${pass}` } }, sign, seal, connector, { product: ["approval-box/decision@1"], answerSchema: "approval-box/answer@1" });
  const answered: { decision_id: string; option_id: string }[] = [];
  try {
    await device.open();
    const waits = await device.join(o.waitMs ?? 10_000);
    if (!waits.length) return { answered };
    await device.dial(waits[0]!);
    for (;;) {
      const req = await device.next("request", o.waitMs ?? 10_000).catch(() => null);
      if (!req) break;
      const content = req.body.content as { decision_id: string; options: { id: string }[] };
      device.ack(req.body.id);
      const option = o.option ?? content.options[0]!.id;
      device.answer(req, { option_id: option });
      const ack = await device.next("ack");
      if (ack.body.result !== "ok") throw new LabError("answer_refused", `the connector refused the answer (${String(ack.body.result)})`);
      answered.push({ decision_id: content.decision_id, option_id: option });
    }
    return { answered };
  } catch (error) {
    throw error instanceof LabError ? error : new LabError((error as { code?: string }).code ?? "answer_failed", (error as Error).message);
  } finally { device.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const common = { ...(env.DEV_URL ? { url: env.DEV_URL } : {}), ...(env.DEV_DATA ? { dataDir: env.DEV_DATA } : {}), ...(env.DEV_SUBJECT ? { subject: env.DEV_SUBJECT } : {}) };
  if (process.argv[2] === "--answer") {
    labAnswer({ ...common, ...(process.argv[3] ? { option: process.argv[3] } : {}) })
      .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
      .catch((e: { code?: string; message: string }) => { console.log(JSON.stringify({ answered: [], error: e.code ?? "answer_failed" })); console.error(`approval-box-dev-answer: ${e.message}`); process.exit(1); });
  } else labApprove({ text: process.argv[2] ?? "", ...common })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); }) // node-datachannel keeps the loop alive otherwise
    .catch((e: { code?: string; message: string }) => { console.log(JSON.stringify({ approved: false, error: e.code ?? "approve_failed" })); console.error(`approval-box-dev-approve: ${e.message}`); process.exit(1); });
}
