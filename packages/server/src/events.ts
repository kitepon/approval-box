import { EventEmitter } from "node:events";
import { type Db, all, run } from "./db.ts";
import { now } from "./ids.ts";

export type UserEvent = { id: number; type: string; data: Record<string, unknown> };

/**
 * アプリ・Web版へ流すイベント。Last-Event-ID で取りこぼしを拾えるよう、表へ残してから流す。
 * コネクタへの知らせ（配送待ちができた）は表へ残さない。コネクタは知らせを受けたら配送待ちを取り直すだけなので。
 */
export class EventHub {
  private readonly db: Db;
  private readonly bus = new EventEmitter();

  constructor(db: Db) {
    this.db = db;
    this.bus.setMaxListeners(0);
  }

  publish(userId: string, type: string, data: Record<string, unknown>) {
    const result = run(this.db, "insert into events (user_id, type, data, at) values (?, ?, ?, ?)", userId, type, JSON.stringify(data), now());
    const event: UserEvent = { id: Number(result.lastInsertRowid), type, data };
    this.bus.emit(`user:${userId}`, event);
  }

  since(userId: string, lastId: number): UserEvent[] {
    return all<{ id: number; type: string; data: string }>(this.db, "select id, type, data from events where user_id = ? and id > ? order by id", userId, lastId)
      .map((row) => ({ id: row.id, type: row.type, data: JSON.parse(row.data) }));
  }

  subscribe(userId: string, listener: (event: UserEvent) => void) {
    this.bus.on(`user:${userId}`, listener);
    return () => this.bus.off(`user:${userId}`, listener);
  }

  notifyConnection(connectionId: string) {
    this.bus.emit(`connection:${connectionId}`);
  }

  subscribeConnection(connectionId: string, listener: () => void) {
    this.bus.on(`connection:${connectionId}`, listener);
    return () => this.bus.off(`connection:${connectionId}`, listener);
  }

  prune(olderThanDays: number) {
    run(this.db, "delete from events where at < ?", new Date(Date.now() - olderThanDays * 86400_000).toISOString());
  }
}
