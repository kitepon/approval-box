import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Api, ServerError } from "../src/api.ts";

async function serve(status: number, contentType: string, body: string) {
  const server = createServer((_req, res) => { res.writeHead(status, { "content-type": contentType }); res.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("前段のHTMLのエラーページは、JSONの例外ではなく「届かなかった」誤りになる", async () => {
  const { server, url } = await serve(502, "text/html", "<!DOCTYPE html><html><body>Bad gateway</body></html>");
  try {
    await assert.rejects(new Api({ server: url, token: "t" }).call("POST", "/decisions", { title: "x" }), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "unreachable");
      assert.match(error.message, /HTTP 502/);
      assert.match(error.message, /list_my_decisions/);
      return true;
    });
  } finally { server.close(); }
});

test("サーバーのJSONの誤りは、今までどおり code と message を返す", async () => {
  const { server, url } = await serve(409, "application/json", JSON.stringify({ error: { code: "confirm_required", message: "確かめて", check_token: "chk_x" } }));
  try {
    await assert.rejects(new Api({ server: url, token: "t" }).call("POST", "/decisions", {}), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, "confirm_required");
      assert.equal(error.body.check_token, "chk_x");
      return true;
    });
  } finally { server.close(); }
});
