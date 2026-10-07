import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as steer from "aiterm-steer-delivery";
import { PROFILE } from "../src/profile.ts";
import { writeJsonFile } from "../src/config.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(20); }
  assert.fail("配送が3秒以内に進みませんでした");
}

for (const scenario of ["reroute", "fetched", "already-emitted", "claimed"] as const) {
  test(`実デーモン: 旧会話のqueuedを${scenario}後に二重配送しない`, async t => {
    const root = mkdtempSync(join(tmpdir(), "ab-routing-"));
    const profile = { ...PROFILE, config_root: () => root, state_root: () => join(root, "state") };
    const old = steer.openChannel(profile, null); const next = steer.openChannel(profile, null);
    const deliveryId = randomUUID();
    await steer.sendToChannel(profile, old.channel_id, deliveryId, "answer");
    if (scenario === "already-emitted") await steer.receiveFromChannel(profile, old.channel_id, { wait_ms: 0 });
    if (scenario === "claimed") writeJsonFile(join(steer.channelRoot(profile), old.channel_id, "claims", `${deliveryId}.json`), { state: "sending" });
    const journal = join(root, "state", "deliveries.json");
    writeJsonFile(journal, { "K-TEST": { delivery_id: deliveryId, channel_id: old.channel_id, harness: "grok", state: "queued", at: new Date().toISOString() } });
    const reports: unknown[] = []; const streams = new Set<ServerResponse>();
    let items = scenario === "fetched" ? [] : [{ decision_id: "K-TEST", delivery_id: deliveryId, route: { channel_id: next.channel_id, harness: "grok" }, text: "answer" }];
    const server = createServer((req, res) => {
      if (req.url?.endsWith("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" }); streams.add(res);
        res.write("event: deliveries\ndata: {}\n\n"); return;
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        let body = ""; req.on("data", x => body += x); req.on("end", () => { reports.push(JSON.parse(body)); items = []; res.end("{}"); });
      } else res.end(JSON.stringify({ items }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    writeJsonFile(join(root, "config.json"), { server: `http://127.0.0.1:${address.port}`, token: "isolated-test" });
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { runDaemon } from ${JSON.stringify(new URL("../src/daemon.ts", import.meta.url).href)}; await runDaemon();`], { env: { ...process.env, APPROVAL_BOX_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", x => stderr += x);
    t.after(async () => {
      child.kill("SIGKILL"); for (const stream of streams) stream.destroy(); server.closeAllConnections(); server.close();
      rmSync(root, { recursive: true, force: true });
    });
    const recorded = () => existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : {};
    await until(() => {
      const entry = recorded()["K-TEST"];
      // 配送先はsendingの保存時点で替わる。受信箱へ保存を終えたqueuedまで待つ。
      return scenario === "reroute" ? entry?.channel_id === next.channel_id && entry.state === "queued" : !entry;
    });
    if (scenario === "reroute") {
      assert.equal(steer.channelDeliveryState(profile, old.channel_id, deliveryId), "withdrawn", stderr);
      const received = await steer.receiveFromChannel(profile, next.channel_id, { wait_ms: 0 });
      assert.equal(received.outcome, "delivered");
      assert.equal((await steer.receiveFromChannel(profile, old.channel_id, { wait_ms: 0 })).outcome, "timeout");
      for (const stream of streams) stream.write("event: deliveries\ndata: {}\n\n");
      await delay(50);
      assert.equal((await steer.receiveFromChannel(profile, next.channel_id, { wait_ms: 0 })).outcome, "timeout");
    } else {
      assert.equal((await steer.receiveFromChannel(profile, next.channel_id, { wait_ms: 0 })).outcome, "timeout", stderr);
      if (scenario === "fetched") assert.equal(steer.channelDeliveryState(profile, old.channel_id, deliveryId), "withdrawn");
      else assert.deepEqual(reports, scenario === "claimed" ? [{ state: "unknown", detail: "配送先の変更前に受け口が本文を取得しました。再送しません" }] : [{ state: "delivered" }]);
    }
  });
}
