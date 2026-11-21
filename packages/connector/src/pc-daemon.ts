// peer-channel の道（c8c）で、デーモンが動かす所: 手元の申請（LocalBox）、peer-channel の connector endpoint、MCPのためのローカルソケット。
// 形は docs/architecture/peer-channel-adoption.md の 7。端末の答えは LocalBox の配送待ちになり、デーモンの今の配送（deliver/report）で届く。
import { rmSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { Connector } from "@kitepon/peer-channel/connector";
import type { SignedSnapshotJson } from "@kitepon/peer-channel";
import { Api } from "./api.ts";
import { osName } from "./version.ts";
import { ANSWER_SCHEMA, DECISION_SCHEMA, LocalBox } from "./local-box.ts";
import { serveLocal, socketPath } from "./local-api.ts";
import { keysFile, loadOrCreateKeys } from "./pc-keys.ts";
import { pcRoot } from "./pc-mode.ts";

/** デーモンが Api の代わりに使う形（申請の経路は手元、受信は答えが来た時の合図）。 */
export type DaemonApi = Pick<Api, "call" | "stream" | "download">;

export type PcOptions = {
  server: string; token: string; connectionId: string; account: string;
  /** ペアリング（契約 5.4）で受け取った、接続を加えた登録の写しとその hash。保存した状態が無い時だけ使う。 */
  admission?: { snapshot: SignedSnapshotJson; hash: string };
  root?: string; socket?: string;
  log?: (message: string) => void;
};

export async function startPeerChannel(o: PcOptions) {
  const root = o.root ?? pcRoot();
  const box = new LocalBox(join(root, "decisions.json"));
  const keys = await loadOrCreateKeys(o.root ? join(root, "keys.json") : keysFile());
  const log = o.log ?? (() => {});
  const connector = new Connector({
    server: { url: o.server.replace(/\/$/, ""), headers: { authorization: `Bearer ${o.token}` } },
    connectionId: o.connectionId, account: o.account, keys,
    ...(o.admission ? { admission: o.admission } : {}),
    product: [DECISION_SCHEMA],
    validate: (schema, content, rid, blobs) => schema === ANSWER_SCHEMA && box.validAnswer(rid, content, blobs.length),
    onAnswer: (a) => box.answered(a.rid, a.content, a.blobs),
    onHold: (rid, held) => box.held(rid, held),
    onClosed: (rid, status) => { if (status === "expired") box.expired(rid); },
    stateDir: join(root, "connector"),
    onError: (code) => log(`peer-channel: ${code}`), // 符号だけ（K・鍵・中身は出さない）
  });
  box.transport = {
    request: (content, blobs) => connector.request({ schema: DECISION_SCHEMA, content, blobs }),
    amend: (rid, content, blobs) => { try { connector.amend(rid, { schema: DECISION_SCHEMA, content, ...(blobs ? { blobs } : {}) }); } catch { log("peer-channel: amend_after_close"); } },
    cancel: (rid, reason) => { try { connector.cancel(rid, reason); } catch { log("peer-channel: cancel_after_close"); } },
  };
  // 接続テストが手元で通ったら、サーバーへ「確認済み」の印だけを送る（契約 Q8。申請・答え・コードは送らない）。届かなければ時間を空けて5回まで。
  box.onSetupPassed = (client) => void (async () => {
    for (let i = 0, wait = 2000; i < 5; i++, wait *= 2) {
      try { await new Api({ server: o.server, token: o.token }).call("POST", "/setup-test/verified", { client, os: osName() }); return; }
      catch (error) { log(`接続テストの確認済みをサーバーへ送れません（${(error as Error).message}）`); await new Promise((r) => setTimeout(r, wait)); }
    }
  })();
  connector.start();
  const path = o.socket ?? socketPath();
  if (process.platform !== "win32") rmSync(path, { force: true }); // 前のデーモンが残した印（席の lock を持つのはこのデーモンだけ）
  const server: Server = await serveLocal(box, path);

  const api: DaemonApi = {
    call: async <T>(method: string, route: string, body?: unknown) => box.route(method, route, body) as T,
    // 答えが来たら、今の SSE と同じく sync を起こす。止める合図まで戻らない。
    stream: (onEvent, signal) => new Promise<void>((resolve) => {
      const wake = () => onEvent("deliveries");
      box.events.on("deliveries", wake);
      onEvent("ready");
      signal.addEventListener("abort", () => { box.events.off("deliveries", wake); resolve(); }, { once: true });
    }),
    download: async (path: string) => box.download(path),
  };
  return {
    box, connector, api,
    stop: () => new Promise<void>((resolve) => { connector.stop(); server.close(() => resolve()); }),
  };
}
export type PeerChannelRuntime = Awaited<ReturnType<typeof startPeerChannel>>;
