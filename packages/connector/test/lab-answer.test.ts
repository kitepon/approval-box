// a514t: the lab plays the phone with the dev server. The lab approver pairs this connector (dev:approve), the connector files a request,
// the same lab device answers it (dev:answer), and the answer waits as a delivery for the seat.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import nodeDataChannel from "node-datachannel";
import { startPairingBinding } from "@kitepon/peer-channel/pairing";
import { labAnswer, labApprove } from "../../server/src/dev-approve.ts";
import { startDevServer } from "../../server/src/dev.ts";
import { ServerError } from "../src/api.ts";
import { writeJsonFile } from "../src/config.ts";
import { startDaemonPeerChannel } from "../src/daemon.ts";
import { LocalApi } from "../src/local-api.ts";
import { admissionFile } from "../src/pc-mode.ts";
import { loadOrCreateKeys } from "../src/pc-keys.ts";

const dir = mkdtempSync(join(tmpdir(), "ab-lab-answer-"));
const savedHome = process.env.APPROVAL_BOX_HOME;
process.env.APPROVAL_BOX_HOME = join(dir, "home");
after(() => { if (savedHome === undefined) delete process.env.APPROVAL_BOX_HOME; else process.env.APPROVAL_BOX_HOME = savedHome; rmSync(dir, { recursive: true, force: true }); });

test("lab: dev:approve pairs, the connector files a request, dev:answer answers it as the same device", { timeout: 90_000 }, async () => {
  const data = join(dir, "dev-data");
  const s = await startDevServer({ port: 0, dataDir: data, log: () => {} });
  let pc: Awaited<ReturnType<typeof startDaemonPeerChannel>>;
  try {
    await assert.rejects(labAnswer({ url: s.url, dataDir: data }), /approved no connector/);
    const started = await (await fetch(`${s.url}/connector/v1/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "lab-body", os: "linux", clients: ["claude-code"] }) })).json() as { pairing_id: string; code: string; poll_secret: string };
    const binding = startPairingBinding(await loadOrCreateKeys());
    const approve = labApprove({ text: binding.qrText(started.code), url: s.url, dataDir: data });
    let token = "";
    for (let i = 0; i < 40 && !token; i++) {
      const r = await (await fetch(`${s.url}/connector/v1/pairing/${started.pairing_id}`, { headers: { "x-poll-secret": started.poll_secret } })).json() as { status: string; token?: string };
      if (r.status === "claimed" && r.token) token = r.token;
    }
    const info = await (await fetch(`${s.url}/connector/v1/connection`, { headers: { authorization: `Bearer ${token}` } })).json() as { connection_id: string; me: { user_id: string } };
    const [admission] = await Promise.all([binding.complete({ server: { url: s.url, headers: { authorization: `Bearer ${token}` } }, account: info.me.user_id, connectionId: info.connection_id }), approve]);
    writeJsonFile(join(dir, "home", "config.json"), { server: s.url, token, connection_id: info.connection_id });
    writeJsonFile(admissionFile(), admission);
    pc = await startDaemonPeerChannel({ server: s.url, token }, () => {}, undefined, undefined, () => ({ schema: "approval-box.daemon-status.v1", mode: "pc", paired: true, reason: "running", version: "test", pid: process.pid }));
    assert.ok(pc);

    const api = new LocalApi();
    const body = { title: "lab", context: "", options: [{ id: "go", label: "出す" }, { id: "wait", label: "待つ" }], requester: "センチ", session_label: "lab", client: "claude-code", route: { channel_id: "c-lab", harness: "other" } };
    const first = await api.call("POST", "/decisions", body).catch((e: unknown) => e) as ServerError;
    const d = await api.call<{ decision_id: string }>("POST", "/decisions", { ...body, check_token: first.body.check_token });

    const answered = await labAnswer({ url: s.url, dataDir: data, option: "wait", waitMs: 5000 });
    assert.deepEqual(answered, { answered: [{ decision_id: d.decision_id, option_id: "wait" }] });
    let item: { text: string } | undefined;
    for (let i = 0; i < 100 && !item; i++) { item = (await api.call<{ items: { decision_id: string; text: string }[] }>("GET", "/deliveries")).items.find((x) => x.decision_id === d.decision_id); if (!item) await new Promise((r) => setTimeout(r, 30)); }
    assert.match(item!.text, /答え: 待つ（option_id=wait）/);
  } finally {
    await pc?.stop();
    await s.close();
    await new Promise((r) => setTimeout(r, 1000)); // the connector side of the lab device's closed call ends on its own
    nodeDataChannel.cleanup();
  }
});
