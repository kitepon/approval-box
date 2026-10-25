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
 const admin=(path:string,body?:unknown,options:{host?:string,remote?:string,token?:string,headers?:Record<string,string>,method?:string}={})=>app.request(`http://${options.host ?? "192.168.1.2:18871"}/api/admin${path}`,{method:options.method ?? (body ? "POST":"GET"),headers:{authorization:`Bearer ${options.token ?? "test-secret"}`,"content-type":"application/json",...options.headers},...(body ? {body:JSON.stringify(body)} : {})},{incoming:{socket:{remoteAddress:options.remote ?? "192.168.1.9"}}});
 return {db,user,app,event,send,admin};
}
test("admin report context preserves legacy acceptance, raw data, grouping and lifecycle", async () => {
 const x=setup();
 const event={...x.event(),code:"api_failed",module:"api",diagnostic_log:{operation:"decisions.list",user_visible:false}};
 assert.equal((await x.send(event)).status,202);
 const fingerprint=diagnosticFingerprint(diagnosticSchema.parse(event));
 const snapshot=()=>({raw:all(x.db,"select * from diagnostics"),groups:all(x.db,"select * from diagnostic_groups"),receipts:all(x.db,"select * from diagnostic_receipts"),sources:all(x.db,"select * from diagnostic_group_sources"),notes:all(x.db,"select * from diagnostic_investigations")});
 const before=snapshot();
 const row=(await (await x.admin("/logs")).json())[0];
 assert.equal(row.fingerprint,fingerprint);assert.equal(row.severity,"high");assert.equal(row.status,"open");assert.equal(row.occurrence_count,1);
 assert.match(row.message_template,/承認一覧取得（decisions\.list）: API処理失敗（詳細不明）/);
 assert.match(row.message_template,/対処=不明（未送信）、回復=不明（未送信）、利用者への表示=なし/);
 assert.equal(row.investigation,undefined);
 assert.deepEqual(row.diagnostic_context,{diagnostic_schema_version:1,device_type:event.device_type,os_version:event.os_version,occurred_at:event.occurred_at,event_id:event.event_id,...event.diagnostic_log});
 assert.deepEqual(JSON.parse((before.raw[0] as {payload:string}).payload),event);
 assert.deepEqual(snapshot(),before);
 await x.admin("/logs/resolve",{fingerprint});
 assert.equal((await x.send(event)).status,202);
 assert.equal((await (await x.admin("/logs")).json())[0].status,"resolved");
 assert.equal((await x.send({...event,event_id:randomUUID()})).status,202);
 const next=(await (await x.admin("/logs")).json())[0];
 assert.equal(next.status,"open");assert.equal(next.severity,"high");assert.equal(next.occurrence_count,2);
});
test("admin report describes observed failures and state without interpreting private codes", async () => {
 const x=setup();
 const cases=[
  {code:"api_failed",module:"api",diagnostic_log:{operation:"decisions.list",http_method:"GET",http_status:502,response_format:"html",handling:"unassessed",user_visible:true,impact_assessment:{severity:"high",recovery:"unknown",summary:"通信失敗後の回復は不明"}}},
  {code:"processing_failed",module:"processing",diagnostic_log:{operation:"auth.apple",error_domain:"com.apple.AuthenticationServices.AuthorizationError",error_code:1000,user_visible:true}},
  {code:"crash",module:"metrickit",diagnostic_log:{operation:"app.crash",signal:0,exception_type:0,exception_code:0,user_visible:false}},
  {code:"hang",module:"metrickit",diagnostic_log:{operation:"app.hang",hang_duration_ms:0,user_visible:false}}
 ];
 for(const c of cases)assert.equal((await x.send({...x.event(),...c})).status,202);
 const rows=await (await x.admin("/logs")).json();
 const api=rows.find((r:any)=>r.category==="api_failed");
 assert.match(api.message_template,/承認一覧取得（decisions\.list）: API処理失敗（GET、HTTP 502、応答形式=html）/);
 assert.match(api.message_template,/対処=unassessed、回復=unknown、利用者への表示=あり/);
 assert.equal(api.severity,"high");assert.equal(api.investigation.summary,"送信元の影響評価（環境原因・アプリ欠陥の断定ではありません）: 通信失敗後の回復は不明");
 const auth=rows.find((r:any)=>r.category==="processing_failed");
 assert.match(auth.message_template,/Appleログイン（auth\.apple）: 処理失敗（domain=com\.apple\.AuthenticationServices\.AuthorizationError、code=1000）/);
 assert.doesNotMatch(auth.message_template,/取消|回復=recovered|原因/);
 assert.equal(auth.severity,"high");
 assert.match(rows.find((r:any)=>r.category==="crash").message_template,/signal=0、exception_type=0、exception_code=0/);
 assert.match(rows.find((r:any)=>r.category==="hang").message_template,/停止時間=0ms/);
});
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
test("Apple authorization domain and code survive HTTP acceptance without rewriting legacy diagnostics",async()=>{
 const x=setup();
 const original={event_id:"00000000-0000-4000-8000-000000000002",occurred_at:"2026-10-01T00:00:00Z",code:"processing_failed",module:"processing",app_version:"0.1.0(34)",device_type:"Mac",os_version:"27.0.0",diagnostic_log:{operation:"auth.apple",error_domain:"other",error_code:1000,handling:"unassessed",user_visible:true}};
 const legacy=diagnosticSchema.parse(original), fingerprint=diagnosticFingerprint(legacy);
 assert.equal(fingerprint,"ad474eabf0bab0c39a507b984d0fe02b627b14cfefbb2159f62a40222f39adfc");
 assert.equal((await x.send(original)).status,202);
 const snapshot=()=>({
  raw:all(x.db,"select * from diagnostics where fingerprint=?",fingerprint),
  group:all(x.db,"select * from diagnostic_groups where fingerprint=?",fingerprint),
  sources:all(x.db,"select * from diagnostic_group_sources where fingerprint=?",fingerprint),
  receipt:all(x.db,"select * from diagnostic_receipts where event_id=?",original.event_id),
 });
 const before=snapshot();
 const preserved={...original,event_id:randomUUID(),diagnostic_log:{...original.diagnostic_log,error_domain:"com.apple.AuthenticationServices.AuthorizationError"}};
 const response=await x.send(preserved);assert.equal(response.status,202);
 assert.deepEqual(await response.json(),{event_id:preserved.event_id,accepted:true,duplicate:false});
 assert.equal((await (await x.send(preserved)).json()).duplicate,true);
 const saved=get<{payload:string}>(x.db,"select payload from diagnostics where event_id=?",preserved.event_id)!;
 assert.deepEqual(JSON.parse(saved.payload),preserved);
 const groups=await (await x.admin("/logs?status=all&limit=500")).json();
 assert.equal(groups.length,2);
 const apple=groups.find((g:any)=>JSON.parse(g.diagnostic_log).error_domain===preserved.diagnostic_log.error_domain);
 assert.notEqual(apple.fingerprint,fingerprint);assert.equal(apple.severity,"high");assert.equal(apple.status,"open");assert.equal(apple.occurrence_count,1);
 assert.equal(JSON.parse(apple.diagnostic_log).error_code,1000);
 assert.equal(apple.diagnostic_context.impact_assessment,undefined);
 for(const diagnostic_log of [
  {...preserved.diagnostic_log,error_domain:"AKAuthenticationError"},
  {...preserved.diagnostic_log,error_domain:"arbitrary private domain"},
  {...preserved.diagnostic_log,userInfo:{detail:"private value"}},
 ]) assert.equal((await x.send({...preserved,event_id:randomUUID(),diagnostic_log})).status,400);
 assert.equal(all(x.db,"select * from diagnostics").length,2);
 assert.deepEqual(snapshot(),before);
 assert.deepEqual(JSON.parse((before.raw[0] as {payload:string}).payload),original);
 assert.equal((before.group[0] as {severity:string}).severity,"high");
 assert.equal((before.group[0] as {status:string}).status,"open");
 assert.equal((before.group[0] as {occurrence_count:number}).occurrence_count,1);
});
test("UserNotifications domain stays distinct from legacy other without inferring impact",async()=>{
 const x=setup();
 const original={event_id:"00000000-0000-4000-8000-000000000001",occurred_at:"2026-10-01T00:00:00Z",code:"processing_failed",module:"processing",app_version:"0.1.0(25)",device_type:"Mac",os_version:"27.0.0",diagnostic_log:{operation:"notifications.authorization",error_domain:"other",error_code:1,handling:"unassessed",user_visible:true}};
 const legacy=diagnosticSchema.parse(original);
 assert.equal(diagnosticFingerprint(legacy),"77a6e8d97a1c0b86ca35641568e79abe98485d21ba600a10854bc4f6652e44ca");
 assert.equal((await x.send(original)).status,202);
 const preserved={...original,event_id:randomUUID(),diagnostic_log:{...original.diagnostic_log,error_domain:"UNErrorDomain"}};
 assert.equal((await x.send(preserved)).status,202);
 assert.equal((await x.send({...preserved,event_id:randomUUID(),diagnostic_log:{...preserved.diagnostic_log,error_domain:"private account detail"}})).status,400);
 let groups=await (await x.admin("/logs?status=all&limit=500")).json();
 assert.equal(groups.length,2);
 const old=groups.find((g:any)=>g.fingerprint===diagnosticFingerprint(legacy));
 assert.equal(old.severity,"high");assert.equal(old.occurrence_count,1);assert.equal(old.status,"open");
 const notification=groups.find((g:any)=>JSON.parse(g.diagnostic_log).error_domain==="UNErrorDomain");
 assert.equal(notification.severity,"high");assert.equal(notification.status,"open");
 assert.equal(notification.diagnostic_context.impact_assessment,undefined);
 const assessed={...preserved,event_id:randomUUID(),diagnostic_log:{...preserved.diagnostic_log,impact_assessment:{severity:"warn",recovery:"unknown",summary:"許可要求が例外終了。登録処理へ進まず、実機の回復は未確認。"}}};
 assert.equal((await x.send(assessed)).status,202);
 groups=await (await x.admin("/logs?status=all&limit=500")).json();
 const updated=groups.find((g:any)=>g.fingerprint===notification.fingerprint);
 assert.equal(updated.occurrence_count,2);assert.equal(updated.severity,"warn");assert.equal(updated.status,"open");
 assert.equal(updated.diagnostic_context.impact_assessment.recovery,"unknown");
 const saved=get<{payload:string;severity:string}>(x.db,"select payload,severity from diagnostics where event_id=?",original.event_id)!;
 assert.deepEqual(JSON.parse(saved.payload),original);assert.equal(saved.severity,"high");
});
test("LAN socket and host required: reject proxy paths, spoofing, wrong/missing bearer",async()=>{
 const x=setup();assert.equal((await x.admin("/logs")).status,200);
 for(const options of [{host:"approval-box.kitepon.dev"},{remote:"203.0.113.1"},{headers:{"x-forwarded-for":"192.168.1.1"}},{headers:{"cf-ray":"a"}},{token:"wrong"}])assert.notEqual((await x.admin("/logs",undefined,options)).status,200);
 assert.equal((await x.app.request("http://192.168.1.2/api/admin/logs",{headers:{authorization:"Bearer test-secret"}})).status,403);
});
test("BugHub aggregation, resolve idempotency, duplicate stays resolved, new occurrence reopens",async()=>{
 const x=setup(), event=x.event();await x.send(event);
 const rows=await (await x.admin("/logs?status=all&limit=500")).json();assert.equal(rows.length,1);
 const row=rows[0];assert.equal(row.severity,"info");assert.equal(row.module,"processing.iPhone");assert.equal(row.occurrence_count,1);assert.equal(typeof row.diagnostic_log,"string");assert.equal(row.diagnostic_log_version,"0.1.0(14)");assert.equal(row.diagnostic_context.diagnostic_schema_version,1);assert.equal(row.diagnostic_context.os_version,"27.0.0");assert.match(row.last_seen,/Z$/);
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

test("crash frames accept absent sample_count without discarding UUID/offset",async()=>{
 const x=setup(), binary_uuid=randomUUID();
 const event={...x.event(),code:"crash",module:"metrickit",diagnostic_log:{operation:"app.crash",user_visible:false,exception_type:1,stack_frames:[{binary_uuid,offset:123},{binary_uuid,offset:456,sample_count:3}]}};
 const response=await x.send(event);assert.equal(response.status,202);
 const row=(await (await x.admin("/logs")).json())[0];
 const log=JSON.parse(row.diagnostic_log);assert.deepEqual(log.stack_frames,event.diagnostic_log.stack_frames);assert.equal(row.severity,"fatal");
});

test("optional trigger preserves grouping, exact receipts and admin/raw observation",async()=>{
 const x=setup(), old=x.event();
 assert.equal((await x.send(old)).status,202);
 const fingerprint=diagnosticFingerprint(diagnosticSchema.parse(old));
 const triggers=["initial_refresh","foreground_refresh","toolbar_refresh","pull_refresh","notification_refresh","login","answer","hold","load_more","events"];
 for(const trigger of triggers) {
  const event={...x.event(),diagnostic_log:{...old.diagnostic_log,trigger}};
  assert.equal(diagnosticFingerprint(diagnosticSchema.parse(event)),fingerprint);
  assert.equal((await x.send(event)).status,202);
  assert.equal((await (await x.send(event)).json()).duplicate,true);
  assert.equal((await x.send({...event,diagnostic_log:{...event.diagnostic_log,trigger:trigger==="events" ? "login":"events"}})).status,409);
  const row=(await (await x.admin("/logs")).json())[0];
  assert.equal(row.diagnostic_context.trigger,trigger);
  assert.equal(JSON.parse(row.diagnostic_log).trigger,trigger);
  const raw=get<{payload:string}>(x.db,"select payload from diagnostics where event_id=?",event.event_id);
  assert.equal(JSON.parse(raw!.payload).diagnostic_log.trigger,trigger);
 }
 assert.equal((await x.send({...old,diagnostic_log:{...old.diagnostic_log,trigger:"login"}})).status,409);
 assert.equal((await (await x.send(old)).json()).duplicate,true);
 for(const diagnostic_log of [{...old.diagnostic_log,trigger:"unknown"},{...old.diagnostic_log,trigger:"https://secret"},{...old.diagnostic_log,trigger:null},{...old.diagnostic_log,trigger:"login",unknown:"secret"}])
  assert.equal((await x.send({...x.event(),diagnostic_log})).status,400);
 const rows=await (await x.admin("/logs")).json();
 assert.equal(rows.length,1);assert.equal(rows[0].fingerprint,fingerprint);assert.equal(rows[0].occurrence_count,11);assert.equal(rows[0].severity,"info");
});

test("investigation PATCH changes only independent note; replay/new diagnostics and state changes retain it",async()=>{
 const x=setup(),event=x.event();await x.send(event);
 const before=(await (await x.admin("/logs")).json())[0];
 assert.equal("investigation" in before,false);
 const original={groups:all(x.db,"select * from diagnostic_groups"),raw:all(x.db,"select * from diagnostics"),receipts:all(x.db,"select * from diagnostic_receipts")};
 const note={summary:"訂正: reset受信なし。根治は未確定。",evidence:["https://example.test/evidence","3窓の経路喪失→通信失敗"]};
 const patch=(body:unknown)=>x.admin(`/logs/${before.fingerprint}/investigation`,body,{method:"PATCH"});
 const r=await patch(note);assert.equal(r.status,200);const saved=await r.json();
 assert.equal(saved.fingerprint,before.fingerprint);assert.deepEqual({...saved.investigation,updated_at:undefined},{...note,updated_at:undefined});assert.ok(Number.isFinite(Date.parse(saved.investigation.updated_at)));
 assert.deepEqual({groups:all(x.db,"select * from diagnostic_groups"),raw:all(x.db,"select * from diagnostics"),receipts:all(x.db,"select * from diagnostic_receipts")},original);
 const row=(await (await x.admin("/logs?status=open")).json())[0];assert.deepEqual(row,{...before,investigation:saved.investigation});
 await x.admin("/logs/resolve",{fingerprint:before.fingerprint,note:"別の解決記録"});
 assert.equal((await (await x.send(event)).json()).duplicate,true);
 assert.equal((await (await x.admin("/logs?status=resolved")).json())[0].investigation.summary,note.summary);
 await x.send({...event,event_id:randomUUID(),app_version:"0.1.0(15)"});
 const repeated=(await (await x.admin("/logs?status=open")).json())[0];assert.equal(repeated.occurrence_count,2);assert.deepEqual(repeated.investigation,saved.investigation);
 const revised={summary:"追加照合、未解決。",evidence:[]};assert.equal((await patch(revised)).status,200);
 const latest=(await (await x.admin("/logs")).json())[0];assert.equal(latest.investigation.summary,revised.summary);assert.deepEqual(latest.investigation.evidence,[]);assert.equal(latest.status,"open");assert.equal(latest.occurrence_count,2);
 assert.equal((await x.send({...x.event(),investigation:note})).status,400);
});

test("investigation uses existing LAN admin authority and bounded independent input",async()=>{
 const x=setup();await x.send(x.event());const row=(await (await x.admin("/logs")).json())[0];const path=`/logs/${row.fingerprint}/investigation`,note={summary:"候補",evidence:[]};
 for(const options of [{token:"wrong"},{token:""},{host:"approval-box.kitepon.dev"},{remote:"203.0.113.1"},{headers:{"cf-ray":"a"}},{headers:{"x-forwarded-for":"192.168.1.1"}}])assert.notEqual((await x.admin(path,note,{...options,method:"PATCH"})).status,200);
 for(const body of [{...note,summary:""},{...note,summary:"a".repeat(4001)},{...note,evidence:Array(21).fill("ref")},{...note,evidence:["a".repeat(1001)]},{...note,evidence:[""]},{...note,evidence:"ref"},{...note,updated_at:"client time"},{...note,status:"resolved"},{...note,payload:"raw"}])assert.equal((await x.admin(path,body,{method:"PATCH"})).status,400);
 assert.equal((await x.admin(path,note,{method:"PATCH",headers:{"content-type":"text/plain"}})).status,415);
 assert.equal((await x.admin(path,{...note,padding:"x".repeat(97*1024)},{method:"PATCH"})).status,413);
 assert.equal((await x.admin("/logs/not-a-fingerprint/investigation",note,{method:"PATCH"})).status,400);
 assert.equal((await x.admin(`/logs/${"a".repeat(64)}/investigation`,note,{method:"PATCH"})).status,404);
 assert.equal(all(x.db,"select * from diagnostic_investigations").length,0);
 const maximal={summary:"あ".repeat(4000),evidence:Array(20).fill("あ".repeat(1000))};assert.equal((await x.admin(path,maximal,{method:"PATCH"})).status,200);
});

test("v3 database migration preserves diagnosis and persists independent investigation across reopen",()=>{
 const directory=mkdtempSync(join(tmpdir(),"approvalbox-investigation-"));
 try {
  const file=join(directory,"test.db");let db=openDb(file);const accounts=new Accounts(db,new EventHub(db),"off");const user=accounts.createUser();
  const event=diagnosticSchema.parse({event_id:randomUUID(),occurred_at:new Date().toISOString(),code:"api_failed",module:"api",app_version:"0.1.0(18)",device_type:"Mac",os_version:"26.0.0",diagnostic_log:{operation:"events",error_domain:"NSURLErrorDomain",error_code:-1005,user_visible:true}});
  new Diagnostics(db).accept(user,event);const original={groups:all(db,"select * from diagnostic_groups"),raw:all(db,"select * from diagnostics")};
  db.exec("drop table diagnostic_investigations; pragma user_version=3");db.close();db=openDb(file);
  assert.equal(get<{user_version:number}>(db,"pragma user_version")?.user_version,9);assert.deepEqual({groups:all(db,"select * from diagnostic_groups"),raw:all(db,"select * from diagnostics")},original);
  const fingerprint=diagnosticFingerprint(event);run(db,"insert into diagnostic_investigations values (?,?,?,?)",fingerprint,"未確定",JSON.stringify(["原文参照"]),"2026-10-07T03:00:00Z");db.close();db=openDb(file);
  assert.equal(get<{summary:string}>(db,"select summary from diagnostic_investigations where fingerprint=?",fingerprint)?.summary,"未確定");assert.deepEqual(all(db,"select * from diagnostics"),original.raw);
  run(db,"delete from diagnostic_groups where fingerprint=?",fingerprint);assert.equal(all(db,"select * from diagnostic_investigations").length,0);db.close();
 } finally {rmSync(directory,{recursive:true,force:true});}
});

test("assessed recovered communication stays raw-only; duplicate receipts and legacy groups remain intact",async()=>{
 const x=setup();
 const input={...x.event(),code:"api_failed",module:"api",diagnostic_log:{operation:"events",user_visible:false,error_domain:"NSURLErrorDomain",error_code:-1005,handling:"reconnecting",impact_assessment:{severity:"info",summary:"Reconnected; display and operations recovered, no loss or duplicate.",recovery:"recovered"}}};
 await x.send(input);await x.send(input);
 assert.equal(all(x.db,"select * from diagnostics").length,1);
 assert.equal(all(x.db,"select * from diagnostic_receipts").length,1);
 assert.equal((await (await x.admin("/logs")).json()).length,0);
 const legacy={...input,event_id:randomUUID(),diagnostic_log:{operation:"events",user_visible:false,error_domain:"NSURLErrorDomain",error_code:-1005}};
 assert.equal(diagnosticFingerprint(diagnosticSchema.parse(input)),diagnosticFingerprint(diagnosticSchema.parse(legacy)));
 await x.send(legacy);let row=(await (await x.admin("/logs")).json())[0];assert.equal(row.severity,"high");
 await x.send({...input,event_id:randomUUID()});row=(await (await x.admin("/logs")).json())[0];assert.equal(row.status,"open");assert.equal(row.severity,"high");assert.equal(row.occurrence_count,2);
 await x.admin("/logs/resolve",{fingerprint:row.fingerprint});await x.send({...input,event_id:randomUUID()});row=(await (await x.admin("/logs")).json())[0];assert.equal(row.status,"resolved");assert.equal(row.occurrence_count,3);
});
test("handling alone and unknown recovery do not hide impact; source severity and evidence are projected",async()=>{
 const x=setup();const base={...x.event(),code:"api_failed",module:"api",diagnostic_log:{operation:"decisions.answer",user_visible:true,error_domain:"NSURLErrorDomain",error_code:-1001,handling:"retry_available"}};
 await x.send(base);let row=(await (await x.admin("/logs")).json())[0];assert.equal(row.severity,"high");
 await x.admin(`/logs/${row.fingerprint}/investigation`,{summary:"Operator findings remain.",evidence:["existing proof"]},{method:"PATCH"});
 await x.send({...base,event_id:randomUUID(),diagnostic_log:{...base.diagnostic_log,impact_assessment:{severity:"high",summary:"Answer outcome remained unknown; user cannot confirm completion.",recovery:"recovered"}}});
 row=(await (await x.admin("/logs")).json())[0];assert.equal(row.severity,"high");assert.equal(row.status,"open");assert.match(row.investigation.summary,/Operator findings remain/);assert.match(row.investigation.summary,/Answer outcome/);assert.equal(row.investigation.evidence[0],"existing proof");
 await x.send({...base,event_id:randomUUID(),diagnostic_log:{...base.diagnostic_log,handling:"handling_failed",impact_assessment:{severity:"warn",summary:"Input remained but retry action stayed disabled.",recovery:"unrecovered"}}});
 row=(await (await x.admin("/logs")).json())[0];assert.equal(row.severity,"warn");assert.match(row.investigation.summary,/retry action/);
 const failing={...base,event_id:randomUUID(),diagnostic_log:{...base.diagnostic_log,handling:"handling_failed",impact_assessment:{severity:"info",summary:"Handling defect confirmed despite eventual recovery.",recovery:"recovered"}}};await x.send(failing);assert.equal(all(x.db,"select * from diagnostics").length,4);assert.equal((await (await x.admin("/logs")).json())[0].occurrence_count,4);
 for(const log of [{...base.diagnostic_log,handling:"offline"},{...base.diagnostic_log,impact_assessment:{severity:"low",summary:"proof",recovery:"recovered"}},{...base.diagnostic_log,impact_assessment:{severity:"info",summary:" ",recovery:"recovered"}},{...base.diagnostic_log,impact_assessment:{severity:"info",summary:"x".repeat(1001),recovery:"recovered"}},{...base.diagnostic_log,impact_assessment:{severity:"info",summary:"proof",recovery:"recovered",payload:"secret"}}]) assert.equal((await x.send({...base,event_id:randomUUID(),diagnostic_log:log})).status,400);
});
test("normal cancellation requires explicit source assessment and known cancellation",async()=>{
 const x=setup(), input={...x.event(),diagnostic_log:{...x.event().diagnostic_log,handling:"normal_cancel",impact_assessment:{severity:"info",summary:"User cancelled normally; no outstanding operation or loss.",recovery:"recovered"}}};
 await x.send(input);assert.equal(all(x.db,"select * from diagnostics").length,1);assert.equal((await (await x.admin("/logs")).json()).length,0);
 await x.send({...input,event_id:randomUUID(),diagnostic_log:{...input.diagnostic_log,cancellation:"unexpected"}});assert.equal((await (await x.admin("/logs")).json()).length,1);
});

test("recovered retry of an unexpected cancellation stays a reference; unassessed or unrecovered ones still register",async()=>{
 const x=setup(), log={operation:"decisions.list",http_method:"GET",user_visible:false,error_domain:"NSURLErrorDomain",error_code:-999,cancellation:"unexpected",trigger:"notification_refresh"};
 const recovered={...x.event(),code:"cancelled",module:"api",diagnostic_log:{...log,handling:"retry_available",impact_assessment:{severity:"info",summary:"The automatic list refresh succeeded on the first retry. No error was shown.",recovery:"recovered"}}};
 assert.equal((await x.send(recovered)).status,202);
 assert.equal(all(x.db,"select * from diagnostics").length,1);assert.equal((await (await x.admin("/logs")).json()).length,0);
 await x.send({...recovered,event_id:randomUUID(),diagnostic_log:{...recovered.diagnostic_log,handling:"reconnecting"}});assert.equal((await (await x.admin("/logs")).json()).length,0);
 // 評価の無い取消、回復していない取消、対処不良は、今までどおり未解決として登録する。
 await x.send({...recovered,event_id:randomUUID(),diagnostic_log:{...log,handling:"retry_available"}});
 let rows=await (await x.admin("/logs")).json();assert.equal(rows.length,1);assert.equal(rows[0].status,"open");assert.equal(rows[0].severity,"warn");
 await x.send({...recovered,event_id:randomUUID(),diagnostic_log:{...log,handling:"retry_available",impact_assessment:{severity:"warn",summary:"Retries were exhausted and an error was shown; the list stayed stale.",recovery:"unrecovered"}}});
 await x.send({...recovered,event_id:randomUUID(),diagnostic_log:{...log,handling:"handling_failed",impact_assessment:{severity:"info",summary:"Recovered, but the retry action stayed disabled.",recovery:"recovered"}}});
 rows=await (await x.admin("/logs")).json();assert.equal(rows.length,1);assert.equal(rows[0].occurrence_count,3);assert.equal(rows[0].status,"open");
 // 既に未解決がある時、参考の発生は回数だけ進め、状態と重大度を動かさない。
 const severity=rows[0].severity;await x.send({...recovered,event_id:randomUUID()});
 rows=await (await x.admin("/logs")).json();assert.equal(rows[0].occurrence_count,4);assert.equal(rows[0].status,"open");assert.equal(rows[0].severity,severity);
});

test("unknown recovery remains registered; bounded administrator notes survive assessment projection and replay",async()=>{
 const x=setup();const input={...x.event(),code:"api_failed",module:"api",diagnostic_log:{operation:"decisions.list",user_visible:false,handling:"reconnecting",impact_assessment:{severity:"info",summary:"Temporary diagnostic, recovery is still unknown.",recovery:"unknown"}}};
 await x.send(input);let row=(await (await x.admin("/logs")).json())[0];assert.equal(row.status,"open");assert.match(row.investigation.summary,/recovery is still unknown/);
 const manual={summary:"m".repeat(4000),evidence:Array.from({length:20},(_,i)=>`proof ${i}`)};
 await x.admin(`/logs/${row.fingerprint}/investigation`,manual,{method:"PATCH"});
 row=(await (await x.admin("/logs")).json())[0];assert.equal(row.investigation.summary,manual.summary);assert.deepEqual(row.investigation.evidence,manual.evidence);
 const changed={...input,diagnostic_log:{...input.diagnostic_log,impact_assessment:{...input.diagnostic_log.impact_assessment,summary:"Different assessment must not reuse the event ID."}}};assert.equal((await x.send(changed)).status,409);
 assert.equal(get<{n:number}>(x.db,"select occurrence_count n from diagnostic_groups")?.n,1);
});
