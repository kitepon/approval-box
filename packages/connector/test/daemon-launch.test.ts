import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsDaemonLaunchScript } from "../src/daemon-launch.ts";

test("Windows常駐adapterは隔離HOMEとCLI探索だけを保持し秘密環境を転送しない", () => {
  const script = windowsDaemonLaunchScript("C:\\Program Files\\nodejs\\node.exe", "C:\\使用者's & $env:X\\cli.mjs", "C:\\状態's\\state", { APPROVAL_BOX_HOME: "C:\\隔離 & '試験", PATH: "C:\\道具", OPENAI_API_KEY: "do-not-forward", TOKEN: "secret-token" });
  const encoded = /Buffer\.from\(''([A-Za-z0-9+/=]+)''/.exec(script)?.[1];
  assert.ok(encoded);
  const bootstrap = Buffer.from(encoded, "base64").toString();
  assert.ok(bootstrap.includes(JSON.stringify("C:\\使用者's & $env:X\\cli.mjs")));
  assert.ok(bootstrap.includes(JSON.stringify("C:\\隔離 & '試験")));
  assert.ok(bootstrap.includes('"PATH":"C:\\\\道具"'));
  assert.ok(!bootstrap.includes("do-not-forward") && !bootstrap.includes("secret-token"));
  assert.ok(script.includes("C:\\状態''s\\state"));
  assert.ok(script.includes("$result.ReturnValue -ne 0"));
});
