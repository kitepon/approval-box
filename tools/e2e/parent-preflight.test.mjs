import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
// Aitermを起動せず、MCPの接続と起動依頼の受け渡しまでを検査する。
// 起動は必ず拒否するので、モデル・通知・本番サーバーを使わない。
const transport = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
for await (const line of createInterface({input:process.stdin})) {
  const r=JSON.parse(line); if(r.id===undefined) continue;
  let result={};
  if(r.method==="initialize") result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"preflight-stub",version:"1"}};
  if(r.method==="tools/call") {
    writeFileSync(process.env.PREFLIGHT_CAPTURE,JSON.stringify({params:r.params,codexHome:process.env.CODEX_HOME,approvalBoxHome:process.env.APPROVAL_BOX_HOME}));
    result={isError:true,content:[{type:"text",text:"PREFLIGHT_STOP_BEFORE_LAUNCH"}]};
  }
  console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));
}
`;

for (const harness of ["codex-cli", "claude-code", "cursor-cli", "grok-cli"]) test(`${harness}: 設定を保持し隔離した接続で起動依頼まで進む`, { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "approval-box-preflight-"));
  let project;
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const config = 'model = "sentinel"\n';
    const hooks = '{"hooks":{"Stop":[]}}\n';
    writeFileSync(join(codexHome, "config.toml"), config);
    writeFileSync(join(codexHome, "hooks.json"), hooks);
    const regularHome = join(root, ".approval-box");
    mkdirSync(regularHome);
    const regularConfig = '{"server":"https://example.invalid","token":"sentinel"}\n';
    writeFileSync(join(regularHome, "config.json"), regularConfig);
    const capture = join(root, "capture.json");
    const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome, PREFLIGHT_CAPTURE: capture, AITERM_CMD: JSON.stringify([process.execPath, "--input-type=module", "-e", transport]) };
    delete env.APPROVAL_BOX_HOME;
    delete env.E2E_REGISTRATION;
    const child = spawnSync(process.execPath, ["tools/e2e/parent-e2e.mjs", harness], { cwd: repo, env, encoding: "utf8", timeout: 25_000 });
    assert.equal(child.error, undefined);
    assert.match(child.stdout, /PREFLIGHT_STOP_BEFORE_LAUNCH/, child.stderr);
    assert.equal(child.status, 1, "起動拒否を成功扱いしない");
    const captured = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(captured.params.name, "agent_launch");
    assert.equal(captured.codexHome, codexHome);
    assert.deepEqual(captured.params.arguments.env_vars, ["APPROVAL_BOX_HOME", ...(harness === "codex-cli" ? ["CODEX_HOME"] : [])]);
    project = captured.params.arguments.cwd;
    const work = join(project, "..");
    assert.equal(captured.approvalBoxHome, join(work, "approval-box-home"));
    if (harness === "codex-cli") {
      const localConfig = readFileSync(join(project, ".codex", "config.toml"), "utf8");
      assert.match(localConfig, /approval_policy = "never"/);
      assert.match(localConfig, /env_vars = \["CODEX_HOME"\]/);
      assert.ok(localConfig.includes(JSON.stringify(captured.approvalBoxHome)));
    }
    if (harness === "claude-code" || harness === "cursor-cli") {
      const file = harness === "claude-code" ? join(project, ".mcp.json") : join(project, ".cursor", "mcp.json");
      const registration = JSON.parse(readFileSync(file, "utf8")).mcpServers["approval-box"];
      assert.equal(registration.command, process.execPath, "Windowsで使えないshell shimを登録しない");
      assert.equal(registration.env.APPROVAL_BOX_HOME, captured.approvalBoxHome);
    }
    assert.equal(readFileSync(join(regularHome, "config.json"), "utf8"), regularConfig);
    assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), config);
    assert.equal(readFileSync(join(codexHome, "hooks.json"), "utf8"), hooks);
    assert.equal(existsSync(join(codexHome, "auth.json")), false, "認証の複製を要しない");
    assert.equal(existsSync(join(work, "codex-home")), false);
    assert.equal(existsSync(join(captured.approvalBoxHome, "codex-parent-hooks")), false);
    assert.equal(existsSync(join(captured.approvalBoxHome, "config.json")), false, "終了処理で試験接続を片付ける");
  } finally {
    if (project) rmSync(join(project, ".."), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
