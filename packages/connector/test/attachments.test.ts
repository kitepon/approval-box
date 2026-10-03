import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "../src/api.ts";
import { safeFileName, saveAll } from "../src/attachments.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("添付: 端末へ保存して場所を返し、中身が合わないものは保存しない", async () => {
  const home = mkdtempSync(join(tmpdir(), "abx-conn-"));
  process.env.APPROVAL_BOX_HOME = home;
  const png = Buffer.from("png-bytes");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.headers.authorization} ${req.url}`);
    if (req.url!.endsWith("/att_png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
    if (req.url!.endsWith("/att_bad")) { res.writeHead(200, { "content-type": "application/pdf" }); res.end("tampered"); return; }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "not_found", message: "その添付は見つかりません。" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = new Api({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "tok" });
    const text = await saveAll(api, "K-ABC234", [
      { id: "att_png", name: "画面:1.png", content_type: "image/png", size: png.length, sha256: sha(png) },
      { id: "att_bad", name: "仕様.pdf", content_type: "application/pdf", size: 3, sha256: sha(Buffer.from("orig")) },
      { id: "att_gone", name: "消えた.txt", content_type: "text/plain", size: 1, sha256: "x" },
    ]);
    const saved = join(home, "attachments", "K-ABC234", "1_画面_1.png");
    assert.match(text, /この端末に保存しました/);
    assert.ok(text.includes(`1. ${saved}`));
    assert.deepEqual(readFileSync(saved), png);
    assert.match(text, /2\. 仕様\.pdf: 保存できませんでした（.*合いません.*）。get_attachment/);
    assert.match(text, /3\. 消えた\.txt: 保存できませんでした（その添付は見つかりません。）/);
    assert.equal(seen[0], "Bearer tok /connector/v1/decisions/K-ABC234/attachments/att_png");
    // 同じ中身があれば取り直さない
    const before = seen.length;
    await saveAll(api, "K-ABC234", [{ id: "att_png", name: "画面:1.png", content_type: "image/png", size: png.length, sha256: sha(png) }]);
    assert.equal(seen.length, before);
  } finally {
    server.close();
    delete process.env.APPROVAL_BOX_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("添付: ファイル名はどのOSでも使える形にする", () => {
  assert.equal(safeFileName('a<b>:c"d/e\\f|g?h*.txt'), "a_b__c_d_e_f_g_h_.txt");
  assert.equal(safeFileName("report. "), "report");
  assert.equal(safeFileName(""), "file");
});
