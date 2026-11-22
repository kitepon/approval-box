#!/usr/bin/env node
// 研究室用の「承認する端末」（c8h）。`npm run dev:approve -- '<PC1PAIR text>'`、答える時は `npm run dev:answer -- [option_id]`、新しい端末を入れる時は `npm run dev:admit -- '<PC1VERIFY text or code>'`。docs/architecture/peer-channel-adoption.md の 8。
// 手元のdevサーバー（ループバックだけ）で、電話もオーナーも無しに、コネクタの peer-channel ペアリング（契約 5.4）を一度通すための偽の端末。
// 試験・本番のサーバーには何もしない: DEV_URL が assertLoopback を通らなければ動かない。鍵も通行証も出力しない。
import { createECDH } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  b64url, bindingTag, checkBindingTag, equal, fingerprint, fromB64url, fromHex, fromJson, join as lpJoin, keyId, parseBody, parseQrText, parseTypedCode,
  sealKeyFromScalar, signingKeyFromScalar, signSnapshot, snapshotHash, toJson, utf8,
  type ConnectorEntry, type DeviceEntry, type SignedSnapshotJson, type SnapshotBody,
} from "@kitepon/peer-channel";
import { verifyIdOf } from "@kitepon/peer-channel/pairing";
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

export type LabAdmitOptions = { text: string; url?: string; dataDir?: string; subject?: string; waitMs?: number };

/**
 * 研究室で「端末を承認する端末」（契約 5.3）: 同じ K で自分でサインインした新しい端末（Linux 版など）が出す PC1VERIFY の文か
 * 16文字のコードを受け、その端末を登録簿の n+1 に入れて上げ、pc1-admit を返す。新しい端末は verify id を開いて待っていること。
 * shortcut: TestDevice.approveConnector の 5.3 版をここに書いた。peer-channel の testing に approveDevice ができたらそれに替える。
 */
export async function labAdmit(o: LabAdmitOptions): Promise<{ admitted: true; key_id: string; platform: string; registry_version: number; k: string }> {
  assertLoopback(o.url ?? "http://127.0.0.1:8788"); // never the test or production server, before anything else
  const qr = parseQrText(o.text.trim());
  const typed = qr ? null : parseTypedCode(o.text);
  if ((qr && qr.kind !== "verify") || (!qr && !typed)) throw new LabError("bad_text", "the text is not a PC1VERIFY text or a 16-character code");
  const secret = qr ? qr.secret : typed!;
  const verifyId = qr?.kind === "verify" ? qr.verifyId : verifyIdOf(secret);
  const { base, call, need, pass, k, sign, seal, head, headBody, saved, save } = await labSession(o);
  const fail = (code: string, why: string): never => { throw new LabError(code, why); };
  const device = new TestDevice({ url: base, headers: { authorization: `Bearer ${pass}` } }, sign, seal, EMPTY_ENTRY);
  const signal = (what: string) => Promise.race([device.nextSignal(), new Promise<never>((_, no) => setTimeout(() => no(new LabError("starter_silent", `no ${what} from the new device`)), o.waitMs ?? 30_000).unref())]);
  try {
    await device.open();
    device.socket.send({ type: "verify.join", verify_id: verifyId });
    const joined = await signal("verify.joined");
    if (joined.type !== "verify.joined" || joined.verify_id !== verifyId) fail(`verify_${joined.code ?? joined.type}`, `verify.join: ${joined.code ?? joined.type} (start the admission again on the new device)`);
    let starter;
    do starter = await signal("pc1-join"); while (!(starter.type === "signal" && starter.verify_id === verifyId && starter.env?.dir === "starter"));
    const nonce = fromB64url(starter.env.nonce);
    const joinPayload = fromB64url(starter.env.payload);
    if (!checkBindingTag(secret, "starter", nonce, joinPayload, fromB64url(starter.env.tag))) fail("binding_failed", "the new device's tag does not check");
    const j = JSON.parse(new TextDecoder().decode(joinPayload)) as { purpose?: string; sig_pub: string; seal_pub: string; platform: DeviceEntry["platform"]; protection: DeviceEntry["protection"]; nonce: string; expires_at: number };
    if (j.purpose !== "join") fail("binding_failed", "the payload is not a pc1-join");
    if (!(Number(j.expires_at) > Date.now())) fail("binding_expired", "the new device's pc1-join has expired");
    if (qr && !equal(fingerprint(fromB64url(j.sig_pub), fromB64url(j.seal_pub)), qr.fingerprint)) fail("binding_failed", "the new device's keys do not match the QR fingerprint");

    const at = Date.now();
    const entry: DeviceEntry = { key_id: b64url(keyId(fromB64url(j.sig_pub))), sig_pub: j.sig_pub, seal_pub: j.seal_pub, platform: j.platform, protection: j.protection, added_at: at, added_by: b64url(sign.id) };
    const body: SnapshotBody = { ...headBody, version: headBody.version + 1, prev: [b64url(snapshotHash(head))], created_at: at, devices: [...headBody.devices, entry] };
    const snap = toJson(signSnapshot(body, sign));
    await need("registry", call("PUT", "/pc/v1/registry", snap, pass), [204]);
    save({ ...saved, snapshot: snap });
    const admit = utf8(JSON.stringify({
      v: "pc/1", purpose: "admit", join_nonce: j.nonce, account: k, registry_version: body.version, registry_hash: b64url(snapshotHash(fromJson(snap))),
      approver_key_id: b64url(sign.id), approver_sig_pub: b64url(sign.pub), expires_at: at + 5 * 60_000,
    }));
    device.socket.send({ type: "signal", verify_id: verifyId, to: joined.peer, env: { dir: "approver", nonce: starter.env.nonce, payload: b64url(admit), tag: b64url(bindingTag(secret, "approver", nonce, lpJoin(joinPayload, admit))) } });
    return { admitted: true, key_id: entry.key_id, platform: entry.platform, registry_version: body.version, k };
  } catch (error) {
    throw error instanceof LabError ? error : new LabError((error as { code?: string }).code ?? "admit_failed", (error as Error).message);
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
  } else if (process.argv[2] === "--admit") {
    labAdmit({ text: process.argv[3] ?? "", ...common })
      .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
      .catch((e: { code?: string; message: string }) => { console.log(JSON.stringify({ admitted: false, error: e.code ?? "admit_failed" })); console.error(`approval-box-dev-admit: ${e.message}`); process.exit(1); });
  } else labApprove({ text: process.argv[2] ?? "", ...common })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); }) // node-datachannel keeps the loop alive otherwise
    .catch((e: { code?: string; message: string }) => { console.log(JSON.stringify({ approved: false, error: e.code ?? "approve_failed" })); console.error(`approval-box-dev-approve: ${e.message}`); process.exit(1); });
}
