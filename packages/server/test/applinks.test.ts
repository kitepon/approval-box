import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Attachments } from "../src/attachments.ts";
import { openDb } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { parseAppLinks } from "../src/applinks.ts";

function appWith(appLinks?: ReturnType<typeof parseAppLinks>["links"]) {
  const db = openDb(":memory:");
  const events = new EventHub(db);
  return createApp({ db, accounts: new Accounts(db, events, "off", new Set()), decisions: new Decisions(db, events), events, publicUrl: "https://ab.example", attachments: new Attachments(db, mkdtempSync(join(tmpdir(), "ab-al-"))), ...(appLinks ? { appLinks } : {}) });
}

test("/.well-known app links: served from the settings as JSON, 404 when unset, malformed entries left out", async () => {
  const fp = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, "0")).join(":");
  const parsed = parseAppLinks(`dev.kitepon.approvalbox=${fp};bad package=XX`, "ABCDE12345.dev.kitepon.approvalbox,notanid");
  assert.deepEqual(parsed.problems, ["AB_ANDROID_APP_LINKS entry 2", "AB_APPLE_APP_IDS entry 2"]);
  const app = appWith(parsed.links);
  const android = await app.request("/.well-known/assetlinks.json");
  assert.equal(android.status, 200);
  assert.equal(android.headers.get("content-type"), "application/json");
  assert.deepEqual(await android.json(), [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "dev.kitepon.approvalbox", sha256_cert_fingerprints: [fp.toUpperCase()] } }]);
  const apple = await app.request("/.well-known/apple-app-site-association");
  assert.equal(apple.status, 200);
  assert.deepEqual(await apple.json(), { applinks: { details: [{ appIDs: ["ABCDE12345.dev.kitepon.approvalbox"], components: [{ "/": "/app/websignin", comment: "web sign-in return (login-billing 1.20)" }] }] } });
  const none = appWith();
  assert.equal((await none.request("/.well-known/assetlinks.json")).status, 404);
  assert.equal((await none.request("/.well-known/apple-app-site-association")).status, 404);
});
