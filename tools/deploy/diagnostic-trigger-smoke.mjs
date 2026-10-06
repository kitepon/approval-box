// Run inside the production server container; never prints credentials.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDb,get} from '/app/server/dist/db.js';
import {Accounts} from '/app/server/dist/accounts.js';
import {EventHub} from '/app/server/dist/events.js';
const db=openDb('/data/approval-box.db');
const accounts=new Accounts(db,new EventHub(db),'off');
const user=accounts.createUser(), token=accounts.issueSession(user,'trigger-smoke').session;
const base='https://approval-box.kitepon.dev/v1';
const headers={'content-type':'application/json',authorization:`Bearer ${token}`};
const send=body=>fetch(`${base}/diagnostics`,{method:'POST',headers,body:JSON.stringify(body)});
const event={event_id:randomUUID(),occurred_at:new Date().toISOString(),code:'cancelled',module:'processing',app_version:'0.1.0(15)',device_type:'iPhone',os_version:'26.6.2',diagnostic_log:{operation:'app.operation',user_visible:false,cancellation:'system',error_code:987650106}};
let fingerprint;
try {
 assert.equal((await send(event)).status,202);
 const newEvent={...event,event_id:randomUUID(),diagnostic_log:{...event.diagnostic_log,trigger:'foreground_refresh'}};
 assert.equal((await send(newEvent)).status,202);
 assert.equal((await (await send(newEvent)).json()).duplicate,true);
 assert.equal((await send({...event,diagnostic_log:newEvent.diagnostic_log})).status,409);
 for(const log of [{...newEvent.diagnostic_log,trigger:'unknown'},{...newEvent.diagnostic_log,secret:'invalid'}]) assert.equal((await send({...event,event_id:randomUUID(),diagnostic_log:log})).status,400);
 const raw=get(db,'select payload,fingerprint from diagnostics where user_id=? and event_id=?',user,newEvent.event_id);
 fingerprint=raw.fingerprint;
 assert.equal(JSON.parse(raw.payload).diagnostic_log.trigger,'foreground_refresh');
 assert.equal(get(db,'select fingerprint from diagnostics where user_id=? and event_id=?',user,event.event_id).fingerprint,fingerprint);
 const key=readFileSync(process.env.DIAGNOSTICS_ADMIN_KEY_FILE,'utf8').trim();
 const adminHeaders={authorization:`Bearer ${key}`,'content-type':'application/json'};
 const admin=`http://127.0.0.1:${process.env.PORT || 8787}/api/admin`;
 const res=await fetch(`${admin}/logs`,{headers:adminHeaders});assert.equal(res.status,200);
 const row=(await res.json()).find(r=>r.fingerprint===fingerprint);
 assert.equal(row.occurrence_count,2);assert.equal(row.diagnostic_context.trigger,'foreground_refresh');assert.equal(JSON.parse(row.diagnostic_log).trigger,'foreground_refresh');
 assert.equal((await fetch(`${admin}/logs/resolve`,{method:'POST',headers:adminHeaders,body:JSON.stringify({fingerprint,note:'Synthetic processing-trigger deployment smoke; no real application failure.'})})).status,200);
 console.log(JSON.stringify({smoke:'passed',fingerprint,raw_trigger:'foreground_refresh',admin_trigger:'foreground_refresh',count:2,synthetic_status:'resolved'}));
} finally {
 const res=await fetch(`${base}/me`,{method:'DELETE',headers});assert.equal(res.status,200);
 assert.equal((await fetch(`${base}/me`,{headers})).status,401);
 assert.equal(get(db,'select count(*) n from diagnostics where user_id=?',user).n,0);
 assert.equal(get(db,'select count(*) n from diagnostic_receipts where user_id=?',user).n,0);
 db.close();console.log('Disposable account, raw events and receipts removed; session returns 401.');
}
