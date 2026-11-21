// peer-channel の道を使うかの判断（ネイティブのモジュールを読まない、MCPとデーモンの両方から使う小さな所）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./profile.ts";

export const pcRoot = () => join(stateRoot(), "pc");

/** 鍵と、ペアリングで受け取った登録（outbox の状態）が手元にある。サーバーの合図（/v1/auth/config の peer_channel）は c8c の後半で足す。 */
export const pcPrepared = (root = pcRoot()) => existsSync(join(root, "keys.json")) && existsSync(join(root, "connector", "connector-state.json"));
