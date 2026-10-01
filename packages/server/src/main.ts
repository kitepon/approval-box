#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { Accounts, type BillingMode } from "./accounts.ts";
import { openDb } from "./db.ts";
import { Decisions } from "./decisions.ts";
import { EventHub } from "./events.ts";
import { createApp } from "./http.ts";

const env = process.env;
const dataDir = resolve(env.APPROVAL_BOX_DATA ?? "data");
const port = Number(env.PORT ?? 8787);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const billing: BillingMode = env.BILLING === "store" ? "store" : "off";

const db = openDb(join(dataDir, "approval-box.db"));
const events = new EventHub(db);
const accounts = new Accounts(db, events, billing);
const decisions = new Decisions(db, events);

const [command, ...args] = process.argv.slice(2);

if (command === "admin") {
  const [sub, value] = args;
  if (sub === "create-user") {
    const userId = accounts.createUser();
    const session = accounts.issueSession(userId, value ?? "admin");
    console.log(JSON.stringify({ user_id: userId, ...session }, null, 2));
  } else if (sub === "login-link") {
    const userId = value && value !== "new" ? value : accounts.createUser();
    console.log(JSON.stringify({ user_id: userId, ...accounts.createLoginLink(userId, args[2] ?? "login-link", publicUrl) }, null, 2));
  } else if (sub === "personal-link" && value) {
    console.log(JSON.stringify({ user_id: value, ...accounts.createPersonalLink(value, publicUrl) }, null, 2));
  } else if (sub === "session" && value) {
    console.log(JSON.stringify(accounts.issueSession(value, "admin"), null, 2));
  } else {
    console.error("usage: approval-box-server admin create-user [label] | admin session <user_id> | admin login-link <user_id|new> [label] | admin personal-link <user_id>");
    process.exit(2);
  }
  process.exit(0);
}

// Web版（packages/web のビルド結果）。APIでないGETは index.html を返し、画面の振り分けはWeb版が行う。
const here = fileURLToPath(new URL(".", import.meta.url));
const webRoot = [env.APPROVAL_BOX_WEB, join(here, "..", "public"), join(here, "..", "..", "web", "dist")].find((dir) => dir && existsSync(join(dir, "index.html")));
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};
function staticHandler(c: Context) {
  if (!webRoot) return c.text("Web版がビルドされていません（npm run build -w packages/web）。", 404);
  const path = decodeURIComponent(new URL(c.req.url).pathname);
  const file = resolve(webRoot, `.${path}`);
  const inside = file.startsWith(resolve(webRoot) + sep);
  const target = inside && existsSync(file) && extname(file) ? file : join(webRoot, "index.html");
  const headers: Record<string, string> = { "content-type": types[extname(target)] ?? "application/octet-stream" };
  if (target.includes(`${sep}assets${sep}`)) headers["cache-control"] = "public, max-age=31536000, immutable";
  else headers["cache-control"] = "no-cache";
  return c.body(readFileSync(target), 200, headers);
}

const app = createApp({ db, accounts, decisions, events, publicUrl }, { staticHandler });

setInterval(() => {
  decisions.purgeExpired();
  accounts.prunePairings();
  events.prune(7);
}, 3600_000).unref();

serve({ fetch: app.fetch, port }, () => {
  console.log(`approval-box-server: ${publicUrl} (port ${port}, data ${dataDir}, billing ${billing}${webRoot ? "" : ", web未ビルド"})`);
});
