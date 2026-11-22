// The lab approver admits a device that signed in by itself (contract 5.3, npm run dev:admit): the new device opens its verify id
// and shows PC1VERIFY, the lab approver checks its tag and fingerprint, signs n+1 with it, and the device's tag check of pc1-admit passes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nodeDataChannel from "node-datachannel";
import {
  b64url, bindingTag, checkBindingTag, fingerprint, fromB64url, fromJson, generateSealKey, generateSigningKey, join as lpJoin, parseBody, qrText, snapshotHash, utf8,
} from "@kitepon/peer-channel";
import { verifyIdOf } from "@kitepon/peer-channel/pairing";
import { TestDevice } from "@kitepon/peer-channel/testing";
import { labAdmit } from "../src/dev-approve.ts";
import { startDevServer } from "../src/dev.ts";

test("the lab approver admits a natively signed-in device by its PC1VERIFY text (5.3)", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-admit-"));
  const s = await startDevServer({ port: 0, dataDir: dir, log: () => {} });
  const post = async (path: string, body: unknown) => (await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  let starter: TestDevice | undefined;
  try {
    await assert.rejects(labAdmit({ text: "PC1VERIFY:x:y:z", url: "https://approval-box-test.kitepon.dev", dataDir: dir }), /loopback/);
    await assert.rejects(labAdmit({ text: "PC1PAIR:ABCD:x:y", url: s.url, dataDir: dir }), { code: "bad_text" });

    // the new device: signs in as the same person, makes its keys and binding secret, opens its verify id
    const { nonce } = await post("/auth/v1/signin/nonce", {});
    const { id_token } = await post("/dev/id-token", { provider: "apple", nonce, sub: "dev-person" });
    const { pass, k } = await post("/auth/v1/signin", { provider: "apple", idToken: id_token, nonce });
    const sign = generateSigningKey(); const seal = await generateSealKey();
    const secret = new Uint8Array(randomBytes(16)); const verifyId = verifyIdOf(secret);
    starter = new TestDevice({ url: s.url, headers: { authorization: `Bearer ${pass}` } }, sign, seal, { key_id: "", sig_pub: "", seal_pub: "", connection_id: "", added_at: 0, added_by: "" });
    await starter.open();
    starter.socket.send({ type: "verify.open", verify_id: verifyId });
    const text = qrText({ kind: "verify", verifyId, fingerprint: fingerprint(sign.pub, seal.pub), secret });

    const admitting = labAdmit({ text, url: s.url, dataDir: dir });
    let joined; do joined = await starter.nextSignal(); while (joined.type !== "verify.joined");
    const n = new Uint8Array(randomBytes(16));
    const joinPayload = utf8(JSON.stringify({ v: "pc/1", purpose: "join", account_hint: null, sig_pub: b64url(sign.pub), seal_pub: b64url(seal.pub), platform: "linux", protection: "os_store", nonce: b64url(n), expires_at: Date.now() + 300_000 }));
    starter.socket.send({ type: "signal", verify_id: verifyId, to: joined.peer, env: { dir: "starter", nonce: b64url(n), payload: b64url(joinPayload), tag: b64url(bindingTag(secret, "starter", n, joinPayload)) } });
    let reply; do reply = await starter.nextSignal(); while (!(reply.type === "signal" && reply.env?.dir === "approver"));
    const admitted = await admitting;

    const admitBytes = fromB64url(reply.env.payload);
    assert.ok(checkBindingTag(secret, "approver", n, lpJoin(joinPayload, admitBytes), fromB64url(reply.env.tag)));
    const admit = JSON.parse(new TextDecoder().decode(admitBytes));
    assert.equal(admit.join_nonce, b64url(n));
    assert.equal(admit.account, k);
    assert.equal(admitted.k, k);
    assert.equal(admitted.platform, "linux");
    assert.equal(admitted.registry_version, 2); // the lab's genesis is 1
    const mirror = await (await fetch(`${s.url}/pc/v1/registry`, { headers: { authorization: `Bearer ${pass}` } })).json() as any;
    const slots: any[] = Array.isArray(mirror) ? mirror : mirror.slots ?? mirror.snapshots ?? [];
    const named = slots.find((x) => b64url(snapshotHash(fromJson(x.snapshot ?? x))) === admit.registry_hash);
    assert.ok(named, "the snapshot named by pc1-admit is in the mirror");
    assert.ok(parseBody(fromJson(named.snapshot ?? named).body)?.devices.some((d) => d.sig_pub === b64url(sign.pub) && d.platform === "linux"));
  } finally { starter?.close(); await s.close(); nodeDataChannel.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
