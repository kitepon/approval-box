// コンテナの入口（tools/deploy/start-with-secrets.sh）。鍵を環境変数で受け取り、tmpfs のファイルへ移してからサーバーを起こす。
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeaderFile } from "../src/callbridge.ts";
import { Apns } from "../src/push.ts";

const entrypoint = fileURLToPath(new URL("../../../tools/deploy/start-with-secrets.sh", import.meta.url));
const posix = { skip: process.platform === "win32" ? "入口は Linux のコンテナの中だけで動く" : false };
const pem = (generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string).trimEnd();
const adminKey = "ab".repeat(32);
const header = "Authorization: Bearer test-token:with=colon and space";

// 入口から env -0 を起こし、サーバーが受け取る環境をそのまま読む。
function start(env: Record<string, string>, command = ["env", "-0"]) {
  const result = spawnSync("sh", [entrypoint, ...command], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  const seen = Object.fromEntries(result.stdout.split("\0").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return { ...result, seen };
}

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "approval-box-secrets-"));
  try { run(dir); } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
}

test("SECRETS_DIR を指定すると、鍵3個を 600 のファイルへ移し、サーバーの環境から値を外す", posix, () => withDir((dir) => {
  const { status, seen } = start({ SECRETS_DIR: dir, APNS_KEY: pem, DIAGNOSTICS_ADMIN_KEY: adminKey, CALL_BRIDGE_HEADERS: header, PUBLIC_URL: "https://example.test" });
  assert.equal(status, 0);
  // 保管庫は末尾の改行を外して持つ。ファイルは末尾に改行1つで、元のファイルと同じ中身になる。
  assert.equal(readFileSync(join(dir, "apns-AuthKey.p8"), "utf8"), pem + "\n");
  assert.equal(readFileSync(join(dir, "diagnostics-admin.key"), "utf8"), adminKey + "\n");
  assert.equal(readFileSync(join(dir, "call-bridge.header"), "utf8"), header + "\n");
  for (const name of readdirSync(dir)) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  for (const name of ["APNS_KEY", "DIAGNOSTICS_ADMIN_KEY", "CALL_BRIDGE_HEADERS"]) assert.equal(name in seen, false, name);
  assert.equal(seen.APNS_KEY_FILE, join(dir, "apns-AuthKey.p8"));
  assert.equal(seen.DIAGNOSTICS_ADMIN_KEY_FILE, join(dir, "diagnostics-admin.key"));
  assert.equal(seen.CALL_BRIDGE_HEADERS_FILE, join(dir, "call-bridge.header"));
  assert.equal(seen.PUBLIC_URL, "https://example.test");
  // 値は、サーバーの環境のどの変数にも残っていない。
  const all = Object.values(seen).join("\n");
  for (const value of [pem.split("\n")[1]!, adminKey, "test-token"]) assert.equal(all.includes(value), false);
  // サーバーの読み方（main.ts と同じ）で読める。
  new Apns({ keyPem: readFileSync(seen.APNS_KEY_FILE!, "utf8"), keyId: "K", teamId: "T", topic: "t" });
  assert.equal(readFileSync(seen.DIAGNOSTICS_ADMIN_KEY_FILE!, "utf8").trim(), adminKey);
  assert.deepEqual(readHeaderFile(seen.CALL_BRIDGE_HEADERS_FILE!), { Authorization: "Bearer test-token:with=colon and space" });
}));

test("APNS_KEY は、改行を \\n と書いた1行でも受ける", posix, () => withDir((dir) => {
  const { status, seen } = start({ SECRETS_DIR: dir, APNS_KEY: pem.replace(/\n/g, "\\n") });
  assert.equal(status, 0);
  assert.equal(readFileSync(seen.APNS_KEY_FILE!, "utf8"), pem + "\n");
}));

test("空の鍵はファイルにしない。ファイルで渡した鍵の指定はそのまま通す", posix, () => withDir((dir) => {
  const { status, seen } = start({ SECRETS_DIR: dir, APNS_KEY: "", DIAGNOSTICS_ADMIN_KEY: adminKey, CALL_BRIDGE_HEADERS_FILE: "/run/elsewhere/call-bridge.header" });
  assert.equal(status, 0);
  assert.deepEqual(readdirSync(dir), ["diagnostics-admin.key"]);
  assert.equal("APNS_KEY_FILE" in seen, false);
  assert.equal(seen.CALL_BRIDGE_HEADERS_FILE, "/run/elsewhere/call-bridge.header");
}));

test("SECRETS_DIR が無ければ、環境をそのまま渡して起こす", posix, () => {
  const { status, seen } = start({ APNS_KEY: pem, DIAGNOSTICS_ADMIN_KEY: adminKey });
  assert.equal(status, 0);
  assert.equal(seen.APNS_KEY, pem);
  assert.equal(seen.DIAGNOSTICS_ADMIN_KEY, adminKey);
  assert.equal("APNS_KEY_FILE" in seen, false);
});

test("書けない置き場ではサーバーを起こさず、値を出さずに止まる", posix, () => withDir((dir) => {
  const marker = join(dir, "started");
  const missing = start({ SECRETS_DIR: join(dir, "missing"), APNS_KEY: pem }, ["touch", marker]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /SECRETS_DIR（.*missing）へ書けません/);
  assert.equal(existsSync(marker), false);
  // 置き場はあるが、ファイルを書けない（同じ名前のフォルダがある）。
  const blocked = mkdtempSync(join(dir, "blocked-"));
  spawnSync("mkdir", [join(blocked, "diagnostics-admin.key")]);
  const failed = start({ SECRETS_DIR: blocked, DIAGNOSTICS_ADMIN_KEY: adminKey }, ["touch", marker]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /DIAGNOSTICS_ADMIN_KEY を .*diagnostics-admin\.key へ書けません/);
  assert.equal(failed.stderr.includes(adminKey), false);
  assert.equal(existsSync(marker), false);
}));
