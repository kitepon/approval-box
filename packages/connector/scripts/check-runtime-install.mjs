import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "ab-runtime-install-")));
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const env = { ...process.env, APPROVAL_BOX_HOME: profile, ...(process.platform === "linux" ? { PATH: "/usr/local/bin:/usr/bin:/bin" } : {}) };
const run = (file, args) => {
  const direct = file.endsWith("/bin/approval-box") && process.platform !== "win32";
  const result = spawnSync(direct ? file : process.execPath, direct ? args : [file, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
};
try {
  const version = run(cli, ["version"]).trim();
  const capabilities = { schema: "approval-box.version.v1", version, capabilities: ["bellteam-requester-wake"] };
  assert.equal(run(cli, ["version", "--json"]), `${JSON.stringify(capabilities)}\n`);
  const launcher = join(profile, "bin", "approval-box");
  assert.equal(run(cli, ["install-runtime"]), launcher + "\n");
  assert.deepEqual(readdirSync(profile).sort(), ["bin", "runtime"]);
  if (process.platform !== "win32") assert.equal(statSync(launcher).mode & 0o777, 0o755);
  const installed = run(launcher, ["version"]).trim();
  assert.equal(installed, version);
  assert.equal(run(launcher, ["version", "--json"]), `${JSON.stringify(capabilities)}\n`);
  const config = join(profile, "config.json");
  const fixture = JSON.stringify({ server: "https://approval-box.kitepon.dev/", token: "synthetic-launcher-fixture" });
  writeFileSync(config, fixture, { mode: 0o600 });
  assert.deepEqual(JSON.parse(run(launcher, ["connection", "export", "--json"])), {
    schema: "approval-box.connection.v1", server: "https://approval-box.kitepon.dev", token: "synthetic-launcher-fixture",
  });
  assert.equal(readFileSync(config, "utf8"), fixture);
  // BellTeam's single writer reads the registration from the installed runtime, never from a vanishing package path.
  const entries = JSON.parse(run(launcher, ["harness-entries", "--json"]));
  assert.equal(entries.schema, "bellteam.harness-entries.v1");
  assert.equal(entries.version, version);
  assert.deepEqual(entries.mcpServers["approval-box"].codex.args, [join(profile, "runtime", version, "cli.mjs"), "mcp"]);
  assert.ok(!JSON.stringify(entries).includes("synthetic-launcher-fixture"));
  assert.deepEqual(readdirSync(profile).sort(), ["bin", "config.json", "runtime"]);
  // Update an existing executable through the installed CLI, preserving the profile.
  writeFileSync(launcher, "old launcher\n");
  assert.equal(run(join(profile, "runtime", version, "cli.mjs"), ["install-runtime"]), launcher + "\n");
  assert.equal(run(launcher, ["version"]).trim(), version);
  assert.deepEqual(readdirSync(join(profile, "bin")), ["approval-box"]);
  assert.equal(readFileSync(config, "utf8"), fixture);
  console.log("runtime installation and stable CLI export passed with synthetic profile");
} finally { rmSync(profile, { recursive: true, force: true }); }
