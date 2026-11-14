import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const syntheticToken = "  synthetic-connection-token \t";
const unavailable = "approval-box: APPROVAL_BOX_CONNECTION_UNAVAILABLE\n";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-box-export-")));
  const config = join(root, "config.json");
  return {
    root,
    config,
    write(value: string | unknown) {
      writeFileSync(config, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
      chmodSync(config, 0o600);
    },
    run(args = ["connection", "export", "--json"]) {
      return spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH, HOME: root, APPROVAL_BOX_HOME: root },
      });
    },
    clean() { rmSync(root, { recursive: true, force: true }); },
  };
}

function isUnavailable(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  assert.ok(result.status === 1, "unavailable config must exit with status 1");
  assert.ok(result.stdout === "", "unavailable config must not write stdout");
  assert.ok(result.stderr === unavailable, "unavailable config must use the fixed error");
}

test("public export returns only the stable connection fields and leaves the profile unchanged", () => {
  const f = fixture();
  try {
    f.write({
      server: "https://approval-box.example.test/api/",
      token: syntheticToken,
      connection_id: "private-connection-id",
      device_name: "private-device-name",
    });
    const before = readFileSync(f.config);
    const modeBefore = lstatSync(f.config).mode & 0o7777;
    const entriesBefore = readdirSync(f.root).sort();

    const result = f.run();
    assert.ok(result.status === 0, "valid profile must export successfully");
    assert.ok(result.stderr === "", "successful export must not write stderr");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.ok(result.stdout === `${JSON.stringify({ schema: "approval-box.connection.v1", server: "https://approval-box.example.test/api", token: syntheticToken })}\n`, "export must be one stable JSON object and newline");
    assert.ok(Object.keys(parsed).sort().join(",") === "schema,server,token", "export must omit private profile fields");
    assert.ok(parsed.token === syntheticToken, "token bytes represented as text must be preserved without trimming");
    assert.ok(readFileSync(f.config).equals(before), "export must not rewrite the profile");
    assert.ok((lstatSync(f.config).mode & 0o7777) === modeBefore, "export must preserve profile mode");
    assert.ok(readdirSync(f.root).sort().join(",") === entriesBefore.join(","), "export must not create profile state");
  } finally { f.clean(); }
});

test("missing profile returns unavailable without output", () => {
  const f = fixture();
  try { isUnavailable(f.run()); }
  finally { f.clean(); }
});

test("malformed JSON and unsafe server or token values fail closed without leaking fixture data", () => {
  const cases = [
    '{"server":',
    { server: "https://user:password@example.test", token: syntheticToken },
    { server: " https://example.test", token: syntheticToken },
    { server: "https://example.test\r\nX-Injected: yes", token: syntheticToken },
    { server: "https://example.test", token: "synthetic-token\nsecond-line" },
    { server: "https://example.test", token: "  \t" },
  ];
  const f = fixture();
  try {
    for (const value of cases) {
      f.write(value);
      const result = f.run();
      isUnavailable(result);
      assert.ok(!result.stderr.includes(syntheticToken), "stderr must not contain the synthetic token");
    }
  } finally { f.clean(); }
});

test("POSIX profile checks reject permissive modes, symbolic links, and hard links", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    f.write({ server: "https://example.test", token: syntheticToken });
    chmodSync(f.config, 0o640);
    isUnavailable(f.run());

    chmodSync(f.config, 0o600);
    const target = join(f.root, "target.json");
    rmSync(f.config);
    writeFileSync(target, JSON.stringify({ server: "https://example.test", token: syntheticToken }), { mode: 0o600 });
    symlinkSync(target, f.config);
    isUnavailable(f.run());

    rmSync(f.config);
    linkSync(target, f.config);
    isUnavailable(f.run());
  } finally { f.clean(); }
});

test("empty and oversized profiles return unavailable", () => {
  const f = fixture();
  try {
    f.write("");
    isUnavailable(f.run());
    f.write(`${"x".repeat(65537)}`);
    isUnavailable(f.run());
  } finally { f.clean(); }
});

test("export requires the explicit JSON command and usage errors never reveal the profile token", () => {
  const f = fixture();
  try {
    f.write({ server: "https://example.test", token: syntheticToken });
    for (const args of [["connection", "export"], ["connection", "export", "--json", "extra"]]) {
      const result = f.run(args);
      assert.ok(result.status === 1, "invalid export command must exit with status 1");
      assert.ok(result.stdout === "", "invalid export command must not write stdout");
      assert.ok(result.stderr.startsWith("approval-box: Usage: approval-box connection export --json\n"), "usage error must identify the required command");
      assert.ok(!result.stderr.includes(syntheticToken), "usage error must not contain the synthetic token");
    }
  } finally { f.clean(); }
});
