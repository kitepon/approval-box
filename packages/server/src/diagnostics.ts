import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { z } from "zod";
import { type Db, all, get, run, tx } from "./db.ts";
import { readLimited } from "./attachments.ts";
import { ApiError } from "./errors.ts";

export const OPERATIONS = ["decisions.list","decisions.detail","decisions.answer","decisions.hold","decisions.unhold","decisions.delete","attachments.list","attachments.upload","attachments.download","attachments.delete","auth.apple","auth.google","auth.logout","account.get","account.settings","account.delete","devices.register","devices.delete","connections.list","connections.delete","tokens.list","tokens.create","tokens.delete","onboarding","pairing.lookup","pairing.claim","pairing.reject","billing.verify","events","storekit.environment","storekit.purchase","storekit.restore","storekit.updates","session.read","session.save","session.clear","notifications.authorization","notifications.register","notifications.badge","attachments.preview","attachments.read","app.operation","app.crash","app.hang"] as const;
export const DECODING_KEYS = ["id","title","context","options","label","recommendation","urgency","deadline","source","client","sessionLabel","via","test","status","answer","optionId","text","answeredAt","attachments","delivery","resumePhrase","createdAt","updatedAt","version","history","at","kind","by","note","fields","cancelReason","distinctReason","items","nextCursor","os","clients","lastSeenAt","lastUsedAt","token","setupCommand","steps","copy","connectionId","decisionId","passedAt","testedAt","failedStep","detail","userId","plan","expiresAt","store","setup","verified","checks","login","retentionDays","session","user","deleted","pairingId","deviceName","contentType","size","sha256","error","code","message","other"] as const;
const integer = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonnegative = integer.min(0);
export const diagnosticSchema = z.strictObject({
  event_id: z.uuid(), occurred_at: z.iso.datetime({ offset: true }),
  code: z.enum(["api_failed","decoding_failed","processing_failed","crash","hang","cancelled"]),
  module: z.enum(["api","processing","metrickit"]),
  app_version: z.string().max(48).regex(/^\d+\.\d+\.\d+\(\d+\)$/),
  device_type: z.enum(["iPhone","iPad","Mac"]), os_version: z.string().max(32).regex(/^\d+\.\d+\.\d+$/),
  diagnostic_log: z.strictObject({
    trigger: z.enum(["initial_refresh","foreground_refresh","toolbar_refresh","pull_refresh","notification_refresh","login","answer","hold","load_more","events"]).optional(),
    operation: z.enum(OPERATIONS), http_method: z.enum(["GET","POST","PATCH","DELETE"]).optional(),
    http_status: integer.min(100).max(599).optional(), response_format: z.enum(["json","html","empty","other"]).optional(),
    error_domain: z.enum(["NSURLErrorDomain","NSCocoaErrorDomain","DecodingError","HTTP","StoreKit","MetricKit","other"]).optional(),
    error_code: integer.optional(), decoding_kind: z.enum(["typeMismatch","valueNotFound","keyNotFound","dataCorrupted"]).optional(),
    decoding_path: z.array(z.union([z.enum(DECODING_KEYS),nonnegative])).max(32).optional(),
    user_visible: z.boolean(), cancellation: z.enum(["system","user","unexpected"]).optional(),
    signal: integer.optional(), exception_type: integer.optional(), exception_code: integer.optional(),
    hang_duration_ms: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    stack_frames: z.array(z.strictObject({binary_uuid: z.uuid(),offset:nonnegative,sample_count:nonnegative.optional()})).max(32).optional(),
  }),
});
type Diagnostic = z.infer<typeof diagnosticSchema>;
export const investigationInputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(1000)).max(20),
});
export type DiagnosticInvestigation = z.infer<typeof investigationInputSchema> & { updated_at: string };
type InvestigationRow = { summary: string; evidence: string; updated_at: string };
function investigationOf(row: InvestigationRow): DiagnosticInvestigation {
  return { summary: row.summary, evidence: JSON.parse(row.evidence) as string[], updated_at: row.updated_at };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function diagnosticFingerprint(input: Diagnostic) {
  const d = input.diagnostic_log;
  return hash(canonical([input.code,input.module,input.device_type,d.operation,d.http_method ?? null,d.error_domain ?? null,d.error_code ?? null,d.http_status ?? null,d.response_format ?? null,d.decoding_kind ?? null,d.decoding_path?.map(k=>typeof k === "number" ? "[]" : k) ?? null,d.cancellation ?? null,d.user_visible,d.signal ?? null,d.exception_type ?? null,d.exception_code ?? null,d.stack_frames?.[0]?.binary_uuid.toLowerCase() ?? null,d.stack_frames?.[0]?.offset ?? null]));
}
function severity(input: Diagnostic) {
  if (input.code === "crash") return "fatal";
  if (input.code === "cancelled") return input.diagnostic_log.user_visible || input.diagnostic_log.cancellation === "unexpected" ? "warn" : "info";
  return "high";
}
export class Diagnostics {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }
  prune() {
    const cutoff = new Date(Date.now()-30*86400_000).toISOString();
    run(this.db,"delete from diagnostics where received_at < ?",cutoff);
    run(this.db,"delete from diagnostics where id not in (select id from diagnostics order by id desc limit 10000)");
    run(this.db,"delete from diagnostic_groups where last_seen < ?",new Date(Date.now()-120*86400_000).toISOString());
    // Receipts outlive the bounded log so retries cannot recreate evicted events.
    run(this.db,"delete from diagnostic_rate where bucket < ?", new Date(Date.now()-2*3600_000).toISOString().slice(0,13));
  }
  accept(userId: string, input: Diagnostic, key?: string) {
    if (key && key !== input.event_id) throw new ApiError("validation_failed","Idempotency-Key は event_id と同じ値にしてください。");
    if (Date.parse(input.occurred_at) > Date.now()+86400_000) throw new ApiError("validation_failed","occurred_at が未来すぎます。");
    const payload = canonical(input), digest = hash(payload);
    return tx(this.db,()=>{
      const prior = get<{payload_hash:string}>(this.db,"select payload_hash from diagnostic_receipts where user_id=? and event_id=?",userId,input.event_id);
      if (prior) {
        if (prior.payload_hash !== digest) throw new ApiError("conflict","同じ event_id の内容が変わっています。");
        return {event_id:input.event_id,accepted:true,duplicate:true};
      }
      const at = new Date().toISOString(), bucket = at.slice(0,13);
      for (const [scope,limit] of [[userId,60],["global",1000]] as const) {
        const count = get<{count:number}>(this.db,"select count from diagnostic_rate where bucket=? and scope=?",bucket,scope)?.count ?? 0;
        if (count >= limit) throw new ApiError("rate_limited","診断の送信上限です。時間を置いてください。",{},3600);
      }
      for (const scope of [userId,"global"]) run(this.db,"insert into diagnostic_rate values (?,?,1) on conflict(bucket,scope) do update set count=count+1",bucket,scope);
      this.prune();
      const fingerprint = diagnosticFingerprint(input);
      const group = get<{fingerprint:string}>(this.db,"select fingerprint from diagnostic_groups where fingerprint=?",fingerprint);
      if (!group && (get<{n:number}>(this.db,"select count(*) n from diagnostic_groups")?.n ?? 0)>=500) throw new ApiError("rate_limited","診断の種類数の上限です。",{},3600);
      run(this.db,"insert into diagnostic_groups (fingerprint,severity,message_template,occurrence_count,first_seen,last_seen,status,payload) values (?,?,?,1,?,?,'open',?) on conflict(fingerprint) do update set severity=excluded.severity,occurrence_count=occurrence_count+1,last_seen=excluded.last_seen,status='open',payload=excluded.payload,resolved_at=null,resolution_note=null",fingerprint,severity(input),`${input.module}.${input.code}: ${input.diagnostic_log.operation} (${input.device_type})`,at,at,payload);
      run(this.db,"insert into diagnostic_receipts values (?,?,?,?)",userId,input.event_id,digest,at);
      run(this.db,"insert into diagnostics (user_id,event_id,received_at,payload,payload_hash,fingerprint,severity) values (?,?,?,?,?,?,?)",userId,input.event_id,at,payload,digest,diagnosticFingerprint(input),severity(input));
      this.prune();
      return {event_id:input.event_id,accepted:true,duplicate:false};
    });
  }
}
export async function readDiagnostic(request: Request) {
  if ((request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError("unsupported_type","application/json を指定してください。");
  const bytes = await readLimited(request.body,16*1024);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError("validation_failed","診断はJSONで送ってください。"); }
  return diagnosticSchema.parse(raw);
}
export function privateAddress(address: string) {
  const a = address.replace(/^::ffff:/,"");
  if (isIP(a) === 4) { const [x,y] = a.split(".").map(Number); return x === 10 || (x === 172 && y! >=16 && y! <=31) || (x ===192 && y ===168) || x ===127; }
  return a === "::1" || (isIP(a) === 6 && /^(fc|fd)/i.test(a));
}
export function diagnosticsAdmin(diagnostics: Diagnostics, token?: string) {
  const app = new Hono();
  app.use("*",async(c,next)=>{
    c.header("Cache-Control","no-store");
    let remote = "";
    try { remote = getConnInfo(c).remote.address ?? ""; } catch { /* no socket: deny */ }
    const host = new URL(c.req.url).hostname.replace(/^\[|\]$/g,"");
    if (!privateAddress(remote) || !privateAddress(host) || ["cf-ray","cf-connecting-ip","forwarded","x-forwarded-for","x-forwarded-host"].some(h=>c.req.header(h)!==undefined)) return c.json({error:"LAN only"},403);
    const auth = c.req.header("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${token ?? ""}`), supplied = Buffer.from(auth);
    if (!token || supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) return c.json({error:"unauthorized"},401);
    await next();
  });
  app.get("/logs",c=>{
    diagnostics.prune();
    const status = c.req.query("status") ?? "all";
    if (!["all","open","resolved"].includes(status)) throw new ApiError("validation_failed","status が正しくありません。");
    const limit = z.coerce.number().int().min(1).max(500).parse(c.req.query("limit") ?? "500");
    const rows = all<{fingerprint:string;severity:string;message_template:string;occurrence_count:number;last_seen:string;status:string;payload:string}>(diagnostics.db,`select * from diagnostic_groups ${status === "all" ? "" : "where status=?"} order by last_seen desc,fingerprint limit ?`,...(status === "all" ? [limit] : [status,limit]));
    return c.json(rows.map(r=>{
      const p = JSON.parse(r.payload) as Diagnostic;
      const note = get<InvestigationRow>(diagnostics.db,"select summary,evidence,updated_at from diagnostic_investigations where fingerprint=?",r.fingerprint);
      return {fingerprint:r.fingerprint,severity:r.severity,message_template:r.message_template,occurrence_count:r.occurrence_count,last_seen:r.last_seen,status:r.status,module:`${p.module}.${p.device_type}`,category:p.code,app_version:p.app_version,diagnostic_log:JSON.stringify(p.diagnostic_log),diagnostic_log_version:p.app_version,diagnostic_log_received_at:r.last_seen,diagnostic_context:{diagnostic_schema_version:1,device_type:p.device_type,os_version:p.os_version,occurred_at:p.occurred_at,event_id:p.event_id,...p.diagnostic_log},...(note ? {investigation: investigationOf(note)} : {})};
    }));
  });
  app.patch("/logs/:fingerprint/investigation",async c=>{
    const fingerprint = z.string().regex(/^[a-f0-9]{64}$/).parse(c.req.param("fingerprint"));
    if ((c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError("unsupported_type","application/json を指定してください。");
    const bytes = await readLimited(c.req.raw.body,96*1024);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError("validation_failed","JSONを送ってください。"); }
    const input = investigationInputSchema.parse(raw);
    const investigation = tx(diagnostics.db,()=>{
      if (!get(diagnostics.db,"select fingerprint from diagnostic_groups where fingerprint=?",fingerprint)) throw new ApiError("not_found","診断がありません。");
      const updated_at = new Date().toISOString();
      run(diagnostics.db,"insert into diagnostic_investigations (fingerprint,summary,evidence,updated_at) values (?,?,?,?) on conflict(fingerprint) do update set summary=excluded.summary,evidence=excluded.evidence,updated_at=excluded.updated_at",fingerprint,input.summary,JSON.stringify(input.evidence),updated_at);
      return { ...input, updated_at };
    });
    return c.json({ fingerprint, investigation });
  });
  for (const action of ["resolve","reopen"] as const) app.post(`/logs/${action}`,async c=>{
    const bytes = await readLimited(c.req.raw.body,4096);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError("validation_failed","JSONを送ってください。"); }
    const p = z.strictObject({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),...(action === "resolve" ? {note:z.string().max(1000).optional()} : {})}).parse(raw);
    const group = get<{status:string}>(diagnostics.db,"select status from diagnostic_groups where fingerprint=?",p.fingerprint);
    if (!group) throw new ApiError("not_found","診断がありません。");
    if (action === "resolve" && group.status !== "resolved") run(diagnostics.db,"update diagnostic_groups set status='resolved',resolved_at=?,resolution_note=? where fingerprint=?",new Date().toISOString(),"note" in p && typeof p.note === "string" ? p.note : null,p.fingerprint);
    if (action === "reopen") run(diagnostics.db,"update diagnostic_groups set status='open',resolved_at=null,resolution_note=null where fingerprint=?",p.fingerprint);
    return c.json({fingerprint:p.fingerprint,status:action === "resolve" ? "resolved" : "open"});
  });
  return app;
}
