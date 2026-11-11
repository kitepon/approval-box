import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("親channelはCodex threadを分離し、永続記録とprocess内記録を使い分ける", t => {
  const root = mkdtempSync(join(tmpdir(), "ab-parent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = new URL("../src/parent-channels.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { channelFor, harnessOf } from ${JSON.stringify(module)};
    const first = await channelFor('codex', 'codex-mcp-client', {threadId:'11111111-1111-4111-8111-111111111111'});
    assert.equal(await channelFor('codex','codex-mcp-client',{threadId:'11111111-1111-4111-8111-111111111111'}), first);
    assert.notEqual(await channelFor('codex','codex-mcp-client',{threadId:'22222222-2222-4222-8222-222222222222'}), first);
    await assert.rejects(channelFor('codex','codex-mcp-client',{}));
    assert.equal(await channelFor('grok','grok',{}), await channelFor('other',undefined,{}));
    const saved = JSON.parse(readFileSync(join(process.env.APPROVAL_BOX_HOME,'state','parents.json'),'utf8'));
    assert.equal(Object.keys(saved).length,2);
    assert.ok(Object.keys(saved).every(key=>key.startsWith('codex:')));
    assert.deepEqual(['claude-code','codex-mcp-client','Cursor','grok-cli',undefined].map(harnessOf),['claude','codex','cursor','grok','other']);
    console.log(first);
  `;
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, APPROVAL_BOX_HOME: root, CODEX_HOME: root } });
  const first = run(), restarted = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout, first.stdout, "新processでも同threadのchannelを再利用する");
});
