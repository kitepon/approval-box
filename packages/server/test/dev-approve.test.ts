// c8h: the lab approver (npm run dev:approve) pairs a connector with the local dev server, with no phone: the connector side starts the pairing,
// the approver reads its PC1PAIR text, claims it, approves the keys, and the connector's binding comes back admitted.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nodeDataChannel from "node-datachannel";
import { generateSealKey, generateSigningKey, fromJson, parseBody } from "@kitepon/peer-channel";
import { startPairingBinding } from "@kitepon/peer-channel/pairing";
import { labApprove } from "../src/dev-approve.ts";
import { startDevServer } from "../src/dev.ts";

test("the lab approver admits a connector's pairing against the dev server and refuses a non-loopback URL", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dev-approve-"));
  const s = await startDevServer({ port: 0, dataDir: dir, log: () => {} });
  try {
    await assert.rejects(labApprove({ text: "PC1PAIR:x:y:z", url: "https://approval-box-test.kitepon.dev", dataDir: dir }), /loopback/);

    // the connector side (what `approval-box pair --json` does)
    const started = await (await fetch(`${s.url}/connector/v1/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "lab-host", os: "linux", clients: ["claude-code"] }) })).json() as { pairing_id: string; code: string; poll_secret: string };
    const binding = startPairingBinding({ sign: generateSigningKey(), seal: await generateSealKey() });
    const approve = labApprove({ text: binding.qrText(started.code), url: s.url, dataDir: dir });

    let claimed: { token: string } | undefined;
    for (let i = 0; i < 40 && !claimed; i++) {
      const r = await (await fetch(`${s.url}/connector/v1/pairing/${started.pairing_id}`, { headers: { "x-poll-secret": started.poll_secret } })).json() as { status: string; token?: string };
      if (r.status === "claimed" && r.token) claimed = { token: r.token };
    }
    assert.ok(claimed, "the claim reached the connector");
    const info = await (await fetch(`${s.url}/connector/v1/connection`, { headers: { authorization: `Bearer ${claimed.token}` } })).json() as { connection_id: string; me: { user_id: string } };

    const [admission, approved] = await Promise.all([
      binding.complete({ server: { url: s.url, headers: { authorization: `Bearer ${claimed.token}` } }, account: info.me.user_id, connectionId: info.connection_id }),
      approve,
    ]);
    assert.equal(approved.approved, true);
    assert.equal(approved.connection_id, info.connection_id);
    assert.equal(approved.k, info.me.user_id);
    const body = parseBody(fromJson(admission.snapshot).body);
    assert.equal(body?.connectors.at(-1)?.connection_id, info.connection_id);
    assert.equal(statSync(join(dir, "lab-approver.json")).mode & 0o777, 0o600);
  } finally { await s.close(); nodeDataChannel.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
