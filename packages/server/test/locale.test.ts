import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, all, get } from "../src/db.ts";
import { Accounts } from "../src/accounts.ts";
import { Decisions } from "../src/decisions.ts";
import { EventHub } from "../src/events.ts";
import { Notifier } from "../src/push.ts";
import { onboarding } from "../src/onboarding.ts";
import { ApiError } from "../src/errors.ts";
import { createApp } from "../src/http.ts";
import { requestLocale } from "../src/locale.ts";

test("language negotiation honors quality, region and exclusions; legacy defaults to Japanese", () => {
  assert.equal(requestLocale(), "ja");
  assert.equal(requestLocale("fr, en-US;q=0.8, ja;q=0.6"), "en");
  assert.equal(requestLocale("en;q=0, ja-JP;q=1"), "ja");
  assert.equal(requestLocale("en;q=garbage, de"), "ja");
});
function setup() {
  const db = openDb(":memory:"), events = new EventHub(db), accounts = new Accounts(db, events, "off"), decisions = new Decisions(db, events);
  const app = createApp({ db, events, accounts, decisions, publicUrl: "https://example.test" });
  const userId = accounts.createUser(), { session } = accounts.issueSession(userId, "test");
  return { db, events, accounts, decisions, app, userId, session };
}
test("HTTP error codes and structured fields stay stable across languages; device locale validates", async () => {
  const { db, app, session } = setup();
  try {
    const ja = await app.request("/v1/me");
    const en = await app.request("/v1/me", { headers: { "accept-language": "en-GB" } });
    assert.equal(en.status, ja.status); assert.equal(en.headers.get("content-language"), "en");
    const j = await ja.json(), e = await en.json();
    assert.equal(e.error.code, j.error.code); assert.match(e.error.message, /sign in/i); assert.notEqual(e.error.message, j.error.message);
    const send = (locale: string) => app.request("/v1/devices", { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json", "accept-language": "en" }, body: JSON.stringify({ platform: "ios", apns_token: "fixture", locale }) });
    assert.equal((await send("en")).status, 200);
    assert.equal(get<{locale:string}>(db,"select locale from devices")?.locale, "en");
    const bad = await send("fr"); assert.equal(bad.status,400); assert.match((await bad.json()).error.message,/Check the request/);
  } finally { db.close(); }
});
test("two devices receive localized fixed push text while request content and silent updates stay intact", async () => {
  const { db, events, accounts, userId } = setup();
  try {
    const ja = accounts.registerDevice(userId, { platform:"ios",apns_token:"j" });
    accounts.registerDevice(userId, { platform:"ios",apns_token:"e",locale:"en" });
    // A legacy re-registration must not reset the explicit English preference.
    accounts.registerDevice(userId, { platform:"ios",apns_token:"e" });
    assert.equal(get<{locale:string}>(db,"select locale from devices where id=?",ja.id)?.locale,"ja");
    const sent: {token:string;payload:any}[]=[];
    const notifier = new Notifier(db, events, async (_env,token,_headers,payload) => { sent.push({token,payload});return {status:200}; });
    // Seed via a normal request, then invoke the notifier directly to avoid polling or real APNs.
    const conn = accounts.createConnection(userId,"fixture","linux",["codex"]);
    const decisions = new Decisions(db,new EventHub(db));
    const actor = {id:conn.id,user_id:userId,label:"fixture",os:"linux"};
    const input = {title:"日本語 request $&",context:"",options:[{id:"a",label:"A"},{id:"b",label:"B"}],session_label:"作業",requester:"名前",client:"codex",urgency:"normal" as const};
    let check_token="";try{decisions.create(actor,input);}catch(e){check_token=(e as {extra:{check_token:string}}).extra.check_token;}
    const d=decisions.create(actor,{...input,check_token});
    await notifier.handle(userId,{id:1,type:"decision.updated",data:{decision_id:d.id,version:2,change:"amended"}});
    assert.equal(sent.find(s=>s.token==="e")!.payload.aps.alert.title,"Updated: 日本語 request $&");
    assert.equal(sent.find(s=>s.token==="j")!.payload.aps.alert.title,"修正: 日本語 request $&");
    assert.equal(sent[0]!.payload.aps.alert.subtitle,"名前 / 作業");
    sent.length=0;
    await notifier.handle(userId,{id:2,type:"decision.updated",data:{decision_id:d.id,version:3,change:"answered"}});
    assert.ok(sent.every(s=>!("alert" in s.payload.aps)&&!("sound" in s.payload.aps)));
    accounts.registerDevice(userId,{platform:"ios",apns_token:"e",locale:"ja"});
    assert.equal(all<{locale:string}>(db,"select locale from devices").filter(d=>d.locale==="ja").length,2);
  }finally{db.close();}
});
test("schema 7 device migration preserves existing fields and defaults only the new locale", () => {
  const dir=mkdtempSync(join(tmpdir(),"approval-locale-")),file=join(dir,"db.sqlite");
  try {
    let db=openDb(file);const events=new EventHub(db),accounts=new Accounts(db,events,"off"),id=accounts.createUser();
    accounts.registerDevice(id,{platform:"ios",apns_token:"fixture",apns_env:"sandbox"});
    db.exec("alter table devices drop column locale; pragma user_version=7");
    const before=all(db,"select * from devices");db.close();db=openDb(file);
    assert.equal(get<{user_version:number}>(db,"pragma user_version")?.user_version,8);
    const after=all<Record<string,unknown>>(db,"select * from devices");assert.equal(after[0]!.locale,"ja");
    assert.deepEqual(after.map(({locale,...rest})=>rest),before.map(row=>({...row as object})));db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("onboarding translates fixed instructions without changing commands or protocol client IDs", () => {
  const ja=onboarding("https://example.test"), en=onboarding("https://example.test","en");
  assert.deepEqual(en.map(g=>g.client),ja.map(g=>g.client));
  for(let i=0;i<en.length;i++) {
    assert.equal(en[i]!.steps[0]!.copy,ja[i]!.steps[0]!.copy);
    assert.equal(en[i]!.steps[2]!.copy,"Run Approval Box setup_test");
    assert.doesNotMatch(JSON.stringify(en[i]),/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
  }
  const e=new ApiError("conflict","申請の内容が変わっています。最新の version で直してください。",{decision:{title:"原文"}});
  assert.equal(e.body("en").error.message,"The request has changed. Update it using the latest version.");
  assert.deepEqual(e.body("en").error.decision,{title:"原文"});
});
