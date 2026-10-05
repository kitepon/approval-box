import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as steer from 'aiterm-steer-delivery';
import { PROFILE } from '../../packages/connector/src/profile.ts';

const root = process.argv[2]; const cli = process.argv[3];
assert.ok(root && cli, 'usage: node script <isolated root with account.json> <cli.mjs>');
const { session } = JSON.parse(readFileSync(join(root, 'account.json'),'utf8'));
const base = 'https://approval-box.kitepon.dev';
const call = async (method, path, body, token=session, headers={}) => {
  const response = await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers}, ...(body ? {body:JSON.stringify(body)} : {})});
  const json = await response.json(); return {status:response.status,json};
};
const start = await call('POST','/connector/v1/pairing',{device_name:'isolated-session-routing-smoke',os:'linux',clients:['grok']},'');
const lookup = await call('GET',`/v1/pairing/lookup?code=${start.json.code}`);
assert.equal((await call('POST',`/v1/pairing/${lookup.json.pairing_id}/claim`)).status,200);
const paired = await call('GET',`/connector/v1/pairing/${start.json.pairing_id}`,undefined,'',{'x-poll-secret':start.json.poll_secret});
const token=paired.json.token; assert.ok(token);
writeFileSync(join(root,'config.json'),JSON.stringify({server:base,token}),{mode:0o600});
const profile={...PROFILE,config_root:()=>root,state_root:()=>join(root,'state')};
const old = steer.openChannel(profile,null); let client;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request={title:'isolated routing smoke',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],client:'grok',session_label:'isolated routing smoke',route:{channel_id:old.channel_id,harness:'grok'}};
try {
  const check=await call('POST','/connector/v1/decisions',request,token); assert.equal(check.status,409);
  const created=await call('POST','/connector/v1/decisions',{...request,check_token:check.json.error.check_token},token);
  assert.equal(created.status,200); const id=created.json.decision_id;
  client=new Client({name:'grok',version:'smoke'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp'],env:{...process.env,APPROVAL_BOX_HOME:root},stderr:'pipe'}));
  const amended=await client.callTool({name:'amend_decision',arguments:{decision_id:id,version:created.json.version,note:'new conversation',changes:{context:'resumed'}}});
  assert.notEqual(amended.isError,true); const channel=amended.structuredContent.steer_channel.channel_id;
  assert.notEqual(channel,old.channel_id);
  const answer=await call('POST',`/v1/decisions/${id}/answer`,{version:amended.structuredContent.version,option_id:'yes'});
  assert.equal(answer.status,200);
  const received=await steer.receiveFromChannel(profile,channel,{wait_ms:10000,poll_ms:50});
  assert.equal(received.outcome,'delivered'); assert.equal(received.deliveries.length,1);
  assert.equal((await steer.receiveFromChannel(profile,old.channel_id,{wait_ms:0})).outcome,'timeout');
  await delay(2500);
  const view=await call('GET',`/connector/v1/decisions/${id}`,undefined,token);
  assert.equal(view.json.delivery,'delivered');
  const resumed=await client.callTool({name:'resume_decision',arguments:{decision_id:id}});
  assert.equal(resumed.structuredContent.delivery,'fetched'); assert.match(resumed.content[0].text,/Yes/);
  console.log('PASS: production amendment changes channel, answer reaches new receiver only, reports delivered, explicit resume retrieves answered decision');
} finally {
  if (client) await client.close();
  const lock=join(root,'state','daemon.json'); if(existsSync(lock)){try{process.kill(JSON.parse(readFileSync(lock,'utf8')).pid,'SIGKILL');}catch{}}
  const deleted=await call('DELETE','/v1/me'); assert.equal(deleted.status,200);
  const denied=await call('GET','/v1/me'); assert.equal(denied.status,401);
  console.log('PASS: isolated production account deleted; session returns 401');
  rmSync(root,{recursive:true,force:true});
}
