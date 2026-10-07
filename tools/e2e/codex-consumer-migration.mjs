// モデル/本番を使わず、公式Codex APIで消費製品hook撤去時の承認保持を確かめる。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as steer from 'aiterm-steer-delivery';
import { PROFILE } from '../../packages/connector/src/profile.ts';
import { register } from '../../packages/connector/src/harness.ts';
const base = process.env.AB_MIGRATION_TEST_ROOT;
if (!base) throw new Error('AB_MIGRATION_TEST_ROOTへ隔離試験の置き場を指定してください');
fs.mkdirSync(base,{recursive:true,mode:0o700});
const root=fs.mkdtempSync(path.join(base,'migration-'));
const home=path.join(root,'codex');fs.mkdirSync(home);
const profile={...PROFILE,config_root:()=>root,state_root:()=>path.join(root,'state')};
const saved=Object.fromEntries(['APPROVAL_BOX_HOME','CODEX_HOME','CODEX_BIN'].map(k=>[k,process.env[k]]));
const binary=process.env.AB_MIGRATION_CODEX_BINARY || 'codex';
const file=path.join(home,'hooks.json');
const group=command=>({matcher:'.*',hooks:[{type:'command',command,timeout:5}]});
const own='echo approval-box-codex-hook.mjs';
const sentinel='echo throughline-user-prompt';
fs.writeFileSync(file,JSON.stringify({hooks:{
 PostToolUse:[group('echo aiterm-common'),group(own),group('echo throughline-post'),group('echo disabled-tool')],
 Stop:[group(own),group('echo throughline-stop')],
 UserPromptSubmit:[group(sentinel)],
}}));
const rpc=fn=>steer.withCodexReceiver(profile,{thread_id:'00000000-0000-4000-8000-000000000000',codex_home:home},fn,{executable:binary});
const list=async()=> (await rpc(request=>request('hooks/list',{cwds:[home]}))).data[0].hooks;
try {
 const hooks=await list();
 await rpc(request=>request('config/batchWrite',{filePath:path.join(home,'config.toml'),edits:hooks.flatMap(h=>[
 {keyPath:`hooks.state.${JSON.stringify(h.key)}.trusted_hash`,value:h.currentHash,mergeStrategy:'replace'},
 {keyPath:`hooks.state.${JSON.stringify(h.key)}.enabled`,value:h.command!=='echo disabled-tool',mergeStrategy:'replace'},
 ])}));
 const before=await list();
 const configDir=steer.codexHookDirectory(profile);fs.mkdirSync(configDir,{recursive:true});
 fs.writeFileSync(path.join(configDir,'config.json'),JSON.stringify({schema:PROFILE.codex_hook_schema,enabled:true,codex_home:home,binary,command:own,node:process.execPath,hook:path.join(root,'legacy-hook.mjs'),stale_processes:[{pid:process.pid,started_identity:'before-hook'}]}));
 process.env.APPROVAL_BOX_HOME=root;process.env.CODEX_HOME=home;process.env.CODEX_BIN=binary;
 const result=await register('codex');assert.equal(result.status,'registered',JSON.stringify(result));
 assert.equal(steer.readCodexHookConfig(profile).enabled,false);
 const repeated=await register('codex');assert.equal(repeated.status,'registered');
 const after=await list();
 const normalized=rows=>rows.filter(h=>h.command!==own).map(h=>({command:h.command,trust:h.trustStatus,enabled:h.enabled,hash:h.currentHash})).sort((a,b)=>a.command.localeCompare(b.command));
 assert.deepEqual(normalized(after),normalized(before));
 assert.equal(after.some(h=>h.command===own),false);
 const state=(await rpc(request=>request('config/read',{includeLayers:false}))).config.hooks.state;
 assert.equal(state[`${fs.realpathSync(file)}:post_tool_use:3:0`],undefined);
 assert.equal(state[`${fs.realpathSync(file)}:stop:1:0`],undefined);
 assert.equal(steer.planCodexParentHooks(file,null,own).changed,false);
 console.log(JSON.stringify({ok:true,removed:2,otherHooks:after.length,disabledPreserved:after.some(h=>h.command==='echo disabled-tool'&&h.enabled===false),method:'consumer standard register → public configureCodexSteer(disable)'}));
} finally {for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}fs.rmSync(root,{recursive:true,force:true})}
