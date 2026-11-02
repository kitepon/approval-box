import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeJsonFile } from '../src/config.ts';

test('MCPはrequest/setupの失敗時にも会話を記録し、amend/resumeの失敗時は直前の会話を保つ', async t => {
  const root=mkdtempSync(join(tmpdir(),'ab-context-'));
  let query='', route='', fail=true;
  const server=createServer((req,res)=>{
    let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{
      res.setHeader('content-type','application/json');
      if(req.method==='GET'){query=req.url!;res.end('{"items":[]}');return;}
      const body=JSON.parse(raw||'{}');route=body.route?.channel_id??body.channel_id;
      if(fail){res.statusCode=500;res.end('{"error":{"code":"internal","message":"isolated failure"}}');}
      else res.end('{"decision_id":"K-TEST","status":"pending"}');
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  writeJsonFile(join(root,'config.json'),{server:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:'isolated'});
  const script=`import {writeJsonFile} from ${JSON.stringify(new URL('../src/config.ts',import.meta.url).href)};
import {runtimeEntry} from ${JSON.stringify(new URL('../src/runtime.ts',import.meta.url).href)};
import {runMcp} from ${JSON.stringify(new URL('../src/mcp.ts',import.meta.url).href)};
writeJsonFile(${JSON.stringify(join(root,'state','daemon.json'))},{pid:process.pid,entry:runtimeEntry('cli')});await runMcp();`;
  const client=new Client({name:'codex-mcp-client',version:'test'});
  t.after(async()=>{await client.close();server.closeAllConnections();server.close();rmSync(root,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--input-type=module','-e',script],env:{...process.env as Record<string,string>,APPROVAL_BOX_HOME:root,CODEX_HOME:root},stderr:'pipe'}));
  const call=(name:string,args:Record<string,unknown>,threadId:string)=>client.callTool({name,arguments:args,_meta:{threadId}});
  const current=async()=>{await client.callTool({name:'list_my_decisions',arguments:{}});return new URL(query,'http://test').searchParams.get('channel_id');};
  const a=randomUUID(),b=randomUUID();
  assert.equal((await call('request_decision',{title:'A',options:[],requester_name:'',session_label:'test'},a)).isError,true);
  const first=route;assert.equal(await current(),first);
  assert.equal((await call('amend_decision',{decision_id:'K-TEST',version:1,note:'test',changes:{}},b)).isError,true);
  const second=route;assert.notEqual(second,first);assert.equal(await current(),first);
  assert.equal((await call('resume_decision',{decision_id:'K-TEST'},b)).isError,true);assert.equal(await current(),first);
  fail=false;
  assert.notEqual((await call('resume_decision',{decision_id:'K-TEST'},b)).isError,true);assert.equal(await current(),second);
  fail=true;
  assert.equal((await call('setup_test',{},a)).isError,true);assert.equal(await current(),first);
  const before=route;
  assert.equal((await call('amend_decision',{decision_id:'K-TEST',changes:{image_paths:['/absent-image.png']}},b)).isError,true);
  assert.equal(route,before,'画像の検査失敗でAPIを呼ばない');assert.equal(await current(),first);
});
