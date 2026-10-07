import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Attachments,MAX_FILE_BYTES } from "../src/attachments.ts";
import { openDb,tx } from "../src/db.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { createApp } from "../src/http.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=','base64');
const ask={title:'画像を見る',options:[{id:'ok',label:'よい'},{id:'no',label:'直す'}],session_label:'image',client:'codex'};
async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'abx-request-'));const db=openDb(':memory:');const events=new EventHub(db);const accounts=new Accounts(db,events,'off');const decisions=new Decisions(db,events);const attachments=new Attachments(db,dir);const app=createApp({db,events,accounts,decisions,attachments,remoteMcp:{attachments},publicUrl:'https://example.test'});
 const user=accounts.createUser();const session=accounts.issueSession(user,'test').session;
 async function call(path:string,body?:unknown,token=session,method=body===undefined?'GET':'POST'){const res=await app.request(path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,json:await res.json() as any};}
 const token=(await call('/v1/tokens',{label:'one'})).json.token;const other=(await call('/v1/tokens',{label:'other'})).json.token;
 async function upload(name='screen.png',data=PNG,who=token,type='image/png'){const r=await app.request(`/connector/v1/request-images?name=${encodeURIComponent(name)}`,{method:'POST',headers:{authorization:`Bearer ${who}`,'content-type':type},body:new Uint8Array(data)});return {status:r.status,json:await r.json() as any};}
 async function create(ids:string[],title=ask.title){const input={...ask,title,request_attachment_ids:ids};const first=await call('/connector/v1/decisions',input,token);return call('/connector/v1/decisions',{...input,check_token:first.json.error.check_token},token);}
 return {dir,db,events,accounts,decisions,attachments,app,session,token,other,call,upload,create,cleanup(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('申請画像: 原子的作成、他接続拒否、認証原本、回答添付分離',async()=>{
 const c=await setup();try{
 const a=await c.upload();assert.equal(a.status,200);assert.equal((await c.upload()).json.id,a.json.id);
 let notifications=0;c.events.subscribeAll((_u,e)=>{if(e.type==='decision.created'){notifications++;const id=String(e.data.decision_id);assert.equal(c.decisions.toApi(c.decisions.forUser(c.accounts.connectionByToken(c.token).user_id,id)).request_attachments.length,1);assert.ok(existsSync(join(c.dir,a.json.id)));assert.doesNotThrow(()=>tx(c.db,()=>{}),'通知はcommit後');}});
 const foreign=await c.upload('other.png',PNG,c.other);assert.equal((await c.create([foreign.json.id])).status,400);assert.equal((await c.create([a.json.id,'missing'])).status,400);assert.equal(notifications,0);
 const made=await c.create([a.json.id]);assert.equal(made.status,200);assert.equal(notifications,1);const id=made.json.decision_id;
 const raw=await c.app.request(`/v1/decisions/${id}/attachments/${a.json.id}`,{headers:{authorization:`Bearer ${c.session}`}});assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),PNG);
 const foreignSession=c.accounts.issueSession(c.accounts.createUser(),'other').session;assert.equal((await c.call(`/v1/decisions/${id}/attachments/${a.json.id}`,undefined,foreignSession)).status,404);
 assert.equal((await c.call(`/v1/decisions/${id}/attachments`)).json.items.length,0);
 assert.equal((await c.call(`/v1/decisions/${id}/answer`,{option_id:'ok',attachment_ids:[a.json.id],version:1})).status,400);
 const answered=await c.call(`/v1/decisions/${id}/answer`,{option_id:'ok',version:1});assert.equal(answered.json.request_attachments[0].id,a.json.id);assert.equal(answered.json.answer.attachments,undefined);
 }finally{c.cleanup();}
});
test('申請画像: 置換/競合/既存再利用/取消/既決削除/期限/account削除',async()=>{
 const c=await setup();try{
 const a=(await c.upload()).json;const id=(await c.create([a.id])).json.decision_id;const b=(await c.upload('new.png')).json;
 const amend=(version:number,ids:string[])=>c.call(`/connector/v1/decisions/${id}/amend`,{version,note:'画像更新',changes:{request_attachment_ids:ids}},c.token);
 assert.equal((await amend(99,[b.id])).status,409);assert.ok(existsSync(join(c.dir,a.id)));
 const updated=await amend(1,[a.id,b.id]);assert.equal(updated.json.request_attachments.length,2);assert.equal(updated.json.version,2);
 assert.equal((await c.call(`/v1/decisions/${id}/answer`,{option_id:'ok',version:1})).status,409);
 assert.equal((await amend(2,[b.id])).json.request_attachments.length,1);assert.equal(existsSync(join(c.dir,a.id)),false);
 await c.call(`/connector/v1/decisions/${id}/cancel`,{reason:'不要'},c.token);assert.equal((await c.call(`/v1/decisions/${id}`)).json.request_attachments[0].id,b.id);assert.ok(existsSync(join(c.dir,b.id)));
 // 取消済み画像はretention対象。
 c.db.prepare("update decisions set updated_at='2000-01-01T00:00:00Z' where id=?").run(id);c.decisions.purgeExpired();c.attachments.gc();assert.equal(existsSync(join(c.dir,b.id)),false);
 const draft=(await c.upload('draft.png')).json;c.db.prepare("update request_uploads set created_at='2000-01-01T00:00:00Z' where id=?").run(draft.id);c.attachments.gc();assert.equal(existsSync(join(c.dir,draft.id)),false);
 const closed=(await c.upload('closed.png')).json;const closedId=(await c.create([closed.id],'既決削除')).json.decision_id;await c.call(`/connector/v1/decisions/${closedId}/cancel`,{reason:'完了'},c.token);c.decisions.deleteClosed(c.accounts.connectionByToken(c.token).user_id);c.attachments.gc();assert.equal(existsSync(join(c.dir,closed.id)),false);
 const revokeDraft=(await c.upload('revoke.png',PNG,c.other)).json;c.accounts.revokeConnection(c.accounts.connectionByToken(c.other).user_id,c.accounts.connectionByToken(c.other).id);c.attachments.gc();assert.equal(existsSync(join(c.dir,revokeDraft.id)),false);
 const bound=(await c.upload('kept.png')).json;await c.create([bound.id],'削除確認');await c.call('/v1/me',undefined,c.session,'DELETE');assert.equal(existsSync(join(c.dir,bound.id)),false);
 }finally{c.cleanup();}
});
test('申請画像: 形式/単体/合計/件数制限、rollbackで通知無し',async()=>{
 const c=await setup();try{
 assert.equal((await c.upload('bad.png',Buffer.from('not png'))).status,415);
 assert.equal((await c.upload('a.pdf',Buffer.from('%PDF-'),'','application/pdf')).status,401);
 assert.equal((await c.upload('a.pdf',Buffer.from('%PDF-'),c.token,'application/pdf')).status,415);
 const big=Buffer.alloc(MAX_FILE_BYTES+1);PNG.copy(big);assert.equal((await c.upload('big.png',big)).status,413);
 const ids=[];for(let i=0;i<3;i++){const data=Buffer.alloc(18*1024*1024);PNG.copy(data);ids.push((await c.upload(`${i}.png`,data)).json.id);}assert.equal((await c.create(ids)).status,413);
 assert.equal((await c.create(Array(11).fill(ids[0]))).status,400);
 let emits=0;c.events.subscribeAll(()=>emits++);assert.throws(()=>tx(c.db,()=>{c.events.publish('u','decision.created',{});throw Error('rollback');}));assert.equal(emits,0);
 }finally{c.cleanup();}
});
test('申請画像: remote MCP schemaとbase64 uploadから正規request/get',async()=>{
 const c=await setup();const client=new Client({name:'image-test',version:'1'});try{
 const transport=new StreamableHTTPClientTransport(new URL('https://example.test/mcp'),{requestInit:{headers:{authorization:`Bearer ${c.token}`}},fetch:async(input,init)=>c.app.request(new Request(input as string,init))});await client.connect(transport);
 const listed=await client.listTools();assert.ok(listed.tools.some(t=>t.name==='upload_request_image'));assert.ok(listed.tools.find(t=>t.name==='request_decision')?.inputSchema.properties?.request_attachment_ids);
 const tool=async(name:string,args:any)=>(await client.callTool({name,arguments:args})) as any;
 assert.equal((await tool('upload_request_image',{name:'a.png',content_type:'image/png',data_base64:'!!!='})).isError,true);
 const maxImage=Buffer.alloc(MAX_FILE_BYTES);PNG.copy(maxImage);const maxUpload=await tool('upload_request_image',{name:'max.png',content_type:'image/png',data_base64:maxImage.toString('base64')});assert.equal(maxUpload.isError,undefined);assert.equal(maxUpload.structuredContent.attachment.size,MAX_FILE_BYTES);
 const a=(await tool('upload_request_image',{name:'a.png',content_type:'image/png',data_base64:PNG.toString('base64')})).structuredContent.attachment;
 const args={title:ask.title,options:ask.options,session_label:'remote',request_attachment_ids:[a.id]};const first=await tool('request_decision',args);const made=await tool('request_decision',{...args,check_token:first.structuredContent.check_token});assert.equal(made.structuredContent.request_attachments[0].id,a.id);
 const raw=await tool('get_attachment',{decision_id:made.structuredContent.decision_id,attachment_id:a.id});assert.equal(raw.content[1].type,'image');assert.equal(raw.content[1].data,PNG.toString('base64'));
 }finally{await client.close();c.cleanup();}
});
