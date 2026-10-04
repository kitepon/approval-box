import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, all, get, run } from "../src/db.ts";
import { Accounts } from "../src/accounts.ts";
import { EventHub } from "../src/events.ts";
import { Decisions } from "../src/decisions.ts";
import { createApp } from "../src/http.ts";
import { Diagnostics, diagnosticFingerprint, diagnosticSchema } from "../src/diagnostics.ts";
function setup() {
 const db=openDb(":memory:"), events=new EventHub(db), accounts=new Accounts(db,events,"off");
 const user=accounts.createUser(), token=accounts.issueSession(user,"test").session;
 const app=createApp({db,events,accounts,decisions:new Decisions(db,events),publicUrl:"https://example.test",diagnosticsAdminToken:"test-secret"});
 const event=()=>({event_id:randomUUID(),occurred_at:new Date().toISOString(),code:"cancelled",module:"processing",app_version:"0.1.0(14)",device_type:"iPhone",os_version:"27.0.0",diagnostic_log:{operation:"app.operation",user_visible:false,cancellation:"system"}});
 const send=(body:unknown,authorization=token)=>app.request("http://192.168.1.2:18871/v1/diagnostics",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${authorization}`},body:JSON.stringify(body)});
 const admin=(path:string,body?:unknown,options:{host?:string,remote?:string,token?:string,headers?:Record<string,string>}={})=>app.request(`http://${options.host ?? "192.168.1.2:18871"}/api/admin${path}`,{method:body ? "POST":"GET",headers:{authorization:`Bearer ${options.token ?? "test-secret"}`,"content-type":"application/json",...options.headers},...(body ? {body:JSON.stringify(body)} : {})},{incoming:{socket:{remoteAddress:options.remote ?? "192.168.1.9"}}});
 return {db,user,app,event,send,admin};
}
test("authenticated diagnostics: exact receipt, replay, conflict, bounded typed payload",async()=>{
 const x=setup(), event=x.event();
 assert.equal((await x.send(event,"")).status,401);
 const first=await x.send(event);assert.equal(first.status,202);assert.deepEqual(await first.json(),{event_id:event.event_id,accepted:true,duplicate:false});
 const second=await x.send({...event,diagnostic_log:{cancellation:"system",user_visible:false,operation:"app.operation"}});assert.equal(second.status,202);assert.equal((await second.json()).duplicate,true);
 assert.equal(get<{n:number}>(x.db,"select count(*) n from diagnostics")?.n,1);
 assert.equal((await x.send({...event,app_version:"0.1.0(15)"})).status,409);
 for(const body of [{...x.event(),session:"secret"},{...x.event(),diagnostic_log:{...event.diagnostic_log,message:"secret"}},{...x.event(),diagnostic_log:{...event.diagnostic_log,decoding_path:["raw_user_value"]}},{...x.event(),diagnostic_log:{...event.diagnostic_log,stack_frames:[{binary_uuid:randomUUID(),offset:-1,sample_count:1}]}},{...x.event(),diagnostic_log:{...event.diagnostic_log,error_code:1.2}}]) assert.equal((await x.send(body)).status,400);
 assert.equal((await x.send({...x.event(),padding:"x".repeat(17000)})).status,413);
});
test("LAN socket and host required: reject proxy paths, spoofing, wrong/missing bearer",async()=>{
 const x=setup();assert.equal((await x.admin("/logs")).status,200);
 for(const options of [{host:"approval-box.kitepon.dev"},{remote:"203.0.113.1"},{headers:{"x-forwarded-for":"192.168.1.1"}},{headers:{"cf-ray":"a"}},{token:"wrong"}])assert.notEqual((await x.admin("/logs",undefined,options)).status,200);
 assert.equal((await x.app.request("http://192.168.1.2/api/admin/logs",{headers:{authorization:"Bearer test-secret"}})).status,403);
});
test("BugHub aggregation, resolve idempotency, duplicate stays resolved, new occurrence reopens",async()=>{
 const x=setup(), event=x.event();await x.send(event);
 const rows=await (await x.admin("/logs?status=all&limit=500")).json();assert.equal(rows.length,1);
 const row=rows[0];assert.equal(row.severity,"info");assert.equal(row.module,"processing.iPhone");assert.equal(row.occurrence_count,1);assert.equal(typeof row.diagnostic_log,"string");assert.equal(row.diagnostic_context.os_version,"27.0.0");assert.match(row.last_seen,/Z$/);
 await x.admin("/logs/resolve",{fingerprint:row.fingerprint,note:"test"});await x.admin("/logs/resolve",{fingerprint:row.fingerprint,note:"test"});await x.send(event);
 let current=(await (await x.admin("/logs")).json())[0];assert.equal(current.status,"resolved");assert.equal(current.occurrence_count,1);
 await x.send({...event,event_id:randomUUID(),app_version:"0.1.0(15)"});current=(await (await x.admin("/logs")).json())[0];assert.equal(current.status,"open");assert.equal(current.occurrence_count,2);assert.equal(current.app_version,"0.1.0(15)");
 await x.admin("/logs/resolve",{fingerprint:row.fingerprint});assert.equal((await x.admin("/logs/reopen",{fingerprint:row.fingerprint})).status,200);
 assert.equal((await x.admin("/logs/resolve",{fingerprint:"a".repeat(64)})).status,404);
});
test("fingerprint excludes versions/index, includes device and crash exception/frame; bounded raw logs preserve receipts",async()=>{
 const x=setup(), d=diagnosticSchema.parse(x.event());const f=diagnosticFingerprint(d);
 assert.equal(diagnosticFingerprint({...d,app_version:"0.1.0(15)",os_version:"28.0.0"}),f);
 assert.notEqual(diagnosticFingerprint({...d,device_type:"Mac"}),f);
 const crash={...d,code:"crash" as const,module:"metrickit" as const,diagnostic_log:{operation:"app.crash" as const,user_visible:false,signal:11,exception_type:1,stack_frames:[{binary_uuid:randomUUID(),offset:100,sample_count:1}]}};
 assert.notEqual(diagnosticFingerprint(crash),diagnosticFingerprint({...crash,diagnostic_log:{...crash.diagnostic_log,exception_type:2}}));
 assert.notEqual(diagnosticFingerprint(crash),diagnosticFingerprint({...crash,diagnostic_log:{...crash.diagnostic_log,stack_frames:[{...crash.diagnostic_log.stack_frames[0]!,offset:200}]}}));
 await x.send(d);run(x.db,"update diagnostics set received_at=?",new Date(Date.now()-31*86400_000).toISOString());new Diagnostics(x.db).prune();assert.equal(all(x.db,"select * from diagnostics").length,0);assert.equal((await (await x.send(d)).json()).duplicate,true);
});
test("persistent rate limit counts new events, retry does not consume allowance",async()=>{
 const x=setup(), event=x.event();await x.send(event);
 run(x.db,"update diagnostic_rate set count=60 where scope=?",x.user);
 assert.equal((await x.send(event)).status,202);
 const r=await x.send(x.event());assert.equal(r.status,429);assert.equal(r.headers.get("retry-after"),"3600");
});

test("receipts, severity and aggregate survive database reopen",()=>{
 const directory=mkdtempSync(join(tmpdir(),"approvalbox-diagnostics-"));
 try {
  const path=join(directory,"test.db");let db=openDb(path);let events=new EventHub(db);let accounts=new Accounts(db,events,"off");const user=accounts.createUser();
  const event=diagnosticSchema.parse({event_id:randomUUID(),occurred_at:new Date().toISOString(),code:"crash",module:"metrickit",app_version:"0.1.0(14)",device_type:"Mac",os_version:"27.0.0",diagnostic_log:{operation:"app.crash",user_visible:false,signal:11,exception_type:1,exception_code:0,stack_frames:[{binary_uuid:randomUUID(),offset:10,sample_count:1}]}});
  new Diagnostics(db).accept(user,event,event.event_id);db.close();db=openDb(path);
  assert.equal(new Diagnostics(db).accept(user,event,event.event_id).duplicate,true);
  assert.equal(get<{severity:string;occurrence_count:number}>(db,"select severity,occurrence_count from diagnostic_groups")?.severity,"fatal");
  assert.equal(get<{n:number}>(db,"select occurrence_count n from diagnostic_groups")?.n,1);
  run(db,"delete from users where id=?",user);assert.equal(all(db,"select * from diagnostic_receipts").length,0);assert.equal(all(db,"select * from diagnostics").length,0);db.close();
 } finally {rmSync(directory,{recursive:true,force:true});}
});
