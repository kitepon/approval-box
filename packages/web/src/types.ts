export type Option = { id: string; label: string };
export type Attachment = { id: string; name: string; content_type: string; kind: "image" | "document" | string; size: number; sha256: string; created_at: string };
export type HistoryEntry = { at: string; kind: string; by: "ai" | "user"; note?: string; fields?: string[] };
export type Decision = {
  id: string; title: string; context: string; options: Option[]; recommendation?: string;
  urgency: "low" | "normal" | "high" | string; deadline?: string;
  // session_label は「申請者 / 作業名」の一行（表示用）。work_label はAIが書いた作業名、requester は申請者の名前（AIの自己申告）、connection_label は接続（端末）の名前。
  source: { client: string; session_label: string; work_label?: string; requester?: string; connection_label?: string; via: string; test?: boolean };
  status: "pending" | "held" | "answered" | "cancelled" | string;
  request_attachments?: Attachment[];
  answer?: { option_id?: string; text?: string; attachments?: Attachment[]; answered_at: string };
  delivery?: "waiting" | "delivered" | "unknown" | "fetched" | string;
  resume_phrase: string; cancel_reason?: string; distinct_reason?: string;
  history: HistoryEntry[]; created_at: string; updated_at: string; version: number;
};
export type Check = { connection_id: string; client: string; os?: string; status: string; decision_id?: string; passed_at?: string; tested_at?: string; failed_step?: string; detail?: string };
export type Me = { user_id: string; login: "apple" | "google" | null; setup: { verified: boolean; verified_at?: string; checks: Check[] }; plan: string; expires_at?: string; store?: string; billing: "off" | "store" };
export type Connection = { id: string; kind: string; label: string; os?: string; clients: string[]; created_at: string; last_seen_at?: string };
export type ApiErrorBody = { code: string; message: string; decision?: Decision };
