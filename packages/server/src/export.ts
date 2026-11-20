// 自分のアカウントに保存している全てを1つのJSONにして渡す（GET /v1/me/export）。形は docs/architecture/login-pass.md「写し」。
// 他のアカウントの値・秘密（接続トークンのハッシュ・通知の宛先・確認コード）は入れない。
import type { Accounts } from "./accounts.ts";
import type { Attachments } from "./attachments.ts";
import { type Db, all, get } from "./db.ts";
import type { Decisions } from "./decisions.ts";
import { now } from "./ids.ts";

export function exportAccount(s: { db: Db; accounts: Accounts; decisions: Decisions; attachments?: Attachments }, userId: string) {
  const { db } = s;
  const account = get<Record<string, unknown>>(db, "select id as user_id, created_at, setup_verified_at, retention_days, plan, plan_expires_at, store from users where id = ?", userId)!;
  const decisions = all<{ id: string }>(db, "select id from decisions where user_id = ? order by created_at, id", userId).map((d) => s.decisions.toApi(s.decisions.forUser(userId, d.id)));
  // 答えに結ぶ前の下書きも、保存しているものなので入れる。ファイルが無い行は中身を null にして、行は残す。
  const attachments = all<{ id: string; decision_id: string; purpose: string; name: string; content_type: string; kind: string; size: number; sha256: string; created_at: string }>(db,
    "select id, decision_id, purpose, name, content_type, kind, size, sha256, created_at from attachments where user_id = ? order by decision_id, created_at, id", userId).map((a) => {
    let data: Buffer | undefined;
    try { data = s.attachments?.readForUser(userId, a.decision_id, a.id).data; } catch { /* ファイルが無い */ }
    return { ...a, data_base64: data ? data.toString("base64") : null };
  });
  return {
    format: "approval-box-export.v1",
    exported_at: now(),
    account,
    decisions,
    attachments,
    connections: s.accounts.connections(userId),
    devices: all(db, "select id, platform, locale, created_at, updated_at from devices where user_id = ? order by created_at", userId),
    setup_checks: all(db, "select connection_id, client, os, status, decision_id, passed_at, tested_at, failed_step, detail from setup_checks where user_id = ? order by client", userId),
  };
}
