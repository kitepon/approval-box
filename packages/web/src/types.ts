export type Option = { id: string; label: string };
export type HistoryEntry = { at: string; kind: string; by: "ai" | "user"; note?: string; fields?: string[] };
export type Decision = {
  id: string; title: string; context: string; options: Option[]; recommendation?: string;
  urgency: "low" | "normal" | "high" | string; deadline?: string;
  source: { client: string; session_label: string; via: string; test?: boolean };
  status: "pending" | "held" | "answered" | "cancelled" | string;
  answer?: { option_id?: string; text?: string; answered_at: string };
  delivery?: "waiting" | "delivered" | "unknown" | "fetched" | string;
  resume_phrase: string; cancel_reason?: string; distinct_reason?: string;
  history: HistoryEntry[]; created_at: string; updated_at: string; version: number;
};
export type Check = { connection_id: string; client: string; os?: string; status: string; decision_id?: string; passed_at?: string; tested_at?: string; failed_step?: string; detail?: string };
export type Me = { user_id: string; setup: { verified: boolean; verified_at?: string; checks: Check[] }; plan: string; expires_at?: string; store?: string; billing: "off" | "store" };
export type Connection = { id: string; kind: string; label: string; os?: string; clients: string[]; created_at: string; last_seen_at?: string };
export type ApiErrorBody = { code: string; message: string; decision?: Decision };
