import * as steer from "aiterm-steer-delivery";
import { launchDaemon } from "./daemon-launch.ts";
import { sendChannelAnswer, channelAnswerState } from "./channel-delivery.ts";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Api } from "./api.ts";
import { type AttachmentMeta, pruneAttachments, saveAll } from "./attachments.ts";
import { readConfig, requireConfig, writeJsonFile } from "./config.ts";
import { PROFILE, stateRoot } from "./profile.ts";
import { runtimeEntry } from "./runtime.ts";

type Delivery = { decision_id: string; delivery_id: string; route: { channel_id: string; harness: string }; text: string; attachments?: AttachmentMeta[] };
export type Entry = {
  delivery_id: string; channel_id: string; harness: string;
  state: "sending" | "queued" | "report"; result?: "delivered" | "unknown" | "failed"; detail?: string; at: string;
  /** 受け口が居ないと初めて見た時刻。戻れば消す。 */
  orphaned_at?: string;
};
type Journal = Record<string, Entry>;

const lockFile = () => join(stateRoot(), "daemon.json");
const journalFile = () => join(stateRoot(), "deliveries.json");
const IDLE_EXIT_MS = 30 * 60_000;
/** 結んだprocessが消えてから、起動し直した同じ会話の待機を待つ時間。 */
const ORPHAN_GRACE_MS = 5 * 60_000;

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function daemonStatus(): { running: boolean; pid?: number; entry?: string } {
  if (!existsSync(lockFile())) return { running: false };
  try {
    const lock = JSON.parse(readFileSync(lockFile(), "utf8")) as { pid: number; entry: string };
    return alive(lock.pid) ? { running: true, pid: lock.pid, entry: lock.entry } : { running: false };
  } catch { return { running: false }; }
}

/** 置き場のpath（…/runtime/<版>/cli.mjs）から版を読む。ビルドしたままの dist などは null。 */
export function versionOfEntry(entry: string): number[] | null {
  const match = /[\\/]runtime[\\/](\d+)\.(\d+)\.(\d+)[\\/]/.exec(entry);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * 動いているデーモンを自分の版に入れ替えるか。同じ置き場なら入れ替えない。
 * 相手のほうが新しい版なら入れ替えない（開いたままの古い会話のMCPが、新しいデーモンを古い版へ戻さないように）。
 */
export function shouldReplaceDaemon(runningEntry: string | undefined, myEntry: string): boolean {
  if (runningEntry === myEntry) return false;
  const running = runningEntry ? versionOfEntry(runningEntry) : null;
  const mine = versionOfEntry(myEntry);
  if (!running || !mine) return true;
  for (let i = 0; i < 3; i++) if (running[i] !== mine[i]) return running[i]! < mine[i]!;
  return true;
}

/**
 * 配送デーモンを起こすnode。長く開いた会話のMCPは、起きた後にnodeが更新されると、自分が起きた時の場所（process.execPath）が消えている
 * （Homebrewは版ごとの場所へ入れて、更新で前の版を消す）。今ある場所を引く。
 */
export function daemonNode(executable: string = process.execPath, exists: (file: string) => boolean = existsSync): string {
  return steer.liveNodeExecutable(executable, exists);
}

export type Receiver = "present" | "closed" | "gone";

/**
 * channelの本文を出せる受け口が居るか。閉じた印（SessionEnd hook）は確定。Claude Codeのprocessが印を書かずに終わると
 * （Aitermの会話替え、強制終了、再起動）印は付かず、本文は受信箱に残り、サーバーは配送待ちのまま止まっていた（2026-11-07 K-CNYUNZ、2026-10-24の2件）。
 * 結んだprocessも、同じ会話の待機（起動し直した会話のhook）も居なければ、誰も出せない。
 */
export function receiverOf(channelId: string, profile = PROFILE, running: (pid: number, startedIdentity: string) => boolean = steer.processIsRunning): Receiver {
  let claude;
  try {
    if (steer.channelClosed(profile, channelId)) return "closed";
    claude = steer.readChannel(profile, channelId).claude;
  } catch { return "present"; } // 読めない時は諦めない。記録が無い配送は safeState が先に failed にする
  if (!claude || running(claude.parent_pid, claude.parent_started_identity)) return "present";
  // shortcut: 待機の記録（claude-sessions/<会話>/waiter.json）は aiterm-steer-delivery の内部配置を読む。公開の口ができたら置き換える。
  try {
    const waiter = JSON.parse(readFileSync(join(steer.channelRoot(profile), "claude-sessions", claude.session_id, "waiter.json"), "utf8")) as { pid?: unknown; started_identity?: unknown };
    if (typeof waiter.pid === "number" && typeof waiter.started_identity === "string" && running(waiter.pid, waiter.started_identity)) return "present";
  } catch { /* 待機の記録が無い */ }
  return "gone";
}

/** 受け口が居ない本文を諦めるか。閉じた印は即。processが消えただけなら、起動し直しを ORPHAN_GRACE_MS の間だけ待つ。 */
export function abandoned(entry: Entry, receiver: Receiver, now = Date.now()): boolean {
  if (receiver === "present") { delete entry.orphaned_at; return false; }
  if (receiver === "closed") return true;
  entry.orphaned_at ??= new Date(now).toISOString();
  return now - Date.parse(entry.orphaned_at) >= ORPHAN_GRACE_MS;
}

/** 配送デーモンが動いていなければ起動する。利用者ごとに1つ。 */
export function ensureDaemon() {
  try {
    if (!readConfig()?.token) return;
    const status = daemonStatus();
    if (status.running && !shouldReplaceDaemon(status.entry, runtimeEntry("cli"))) return;
    if (status.running && status.pid) { try { process.kill(status.pid); } catch { /* 既に終わっている */ } }
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
    launchDaemon(daemonNode(), runtimeEntry("cli"), stateRoot());
  } catch (error) {
    process.stderr.write(`approval-box: 配送デーモンを起動できません: ${(error as Error).message}\n`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDaemon() {
  // 版の入れ替えでは、止められた前のデーモンが終わるまで数秒かかる。待たずに「もう動いている」と見て終わると、
  // 前のデーモンも終わってデーモンがいなくなり、次にMCPが起こすまで答えが届かない（2026-10-03 の実測）。
  for (let i = 0; i < 50; i++) {
    const other = daemonStatus();
    if (!other.running || other.pid === process.pid) break;
    await sleep(200);
  }
  const status = daemonStatus();
  if (status.running && status.pid !== process.pid) return;
  writeJsonFile(lockFile(), { pid: process.pid, entry: runtimeEntry("cli"), started_at: new Date().toISOString() });
  const api = new Api(requireConfig());
  let journal: Journal = existsSync(journalFile()) ? (JSON.parse(readFileSync(journalFile(), "utf8")) as Journal) : {};
  const save = () => writeJsonFile(journalFile(), journal);
  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

  // 前回の途中で落ちた送信は、届いたか分からない。送り直さず unknown として返す（受信箱に残っていれば待つ）。
  for (const [id, entry] of Object.entries(journal)) {
    if (entry.state !== "sending") continue;
    const current = await safeState(entry);
    if (current === "queued" || current === "emitted" || current === "sending") entry.state = "queued";
    else Object.assign(entry, { state: "report", result: "unknown", detail: "送信の途中で配送デーモンが止まりました" });
    journal[id] = entry;
  }
  save();
  try { pruneAttachments(); } catch (error) { log(`古い添付の片付けに失敗: ${(error as Error).message}`); }

  async function report(id: string) {
    const entry = journal[id]!;
    try {
      await api.call("POST", `/deliveries/${encodeURIComponent(id)}`, { state: entry.result, ...(entry.detail ? { detail: entry.detail } : {}) });
      delete journal[id];
      save();
    } catch (error) {
      log(`報告に失敗（あとで送り直す）: ${id} ${(error as Error).message}`);
    }
  }

  async function deliver(item: Delivery) {
    const existing = journal[item.decision_id];
    if (existing) return;
    // 添付は届ける前に端末へ保存し、場所を書き足す（AIがすぐ開けるように）。保存に失敗しても答えは届ける。
    // 届いた文の出どころを、AIが自分で呼ぶ道具で確かめられるようにする。作業の途中に道具の結果と一緒に届いた答えを、
    // AIが本物と扱わず採らなかった例がある（2026-10-11 K-GRELNG）。
    const verify = `\n確かめる時は、Approval Boxの get_decision を decision_id="${item.decision_id}" で呼ぶと、同じ答えが返ります。`;
    const text = (item.attachments?.length ? item.text + await saveAll(api, item.decision_id, item.attachments) : item.text) + verify;
    journal[item.decision_id] = { delivery_id: item.delivery_id, channel_id: item.route.channel_id, harness: item.route.harness, state: "sending", at: new Date().toISOString() };
    save();
    const entry = journal[item.decision_id]!;
    try {
      const result = await sendChannelAnswer(item.route.channel_id, item.delivery_id, text);
      if (result.state === "submitted") Object.assign(entry, { state: "report", result: "delivered" });
      else entry.state = "queued";
    } catch (error) {
      const e = error as { outcome_unknown?: boolean; closed?: boolean; delivery_code?: string; message: string };
      Object.assign(entry, { state: "report", result: e.outcome_unknown ? "unknown" : "failed", detail: e.closed ? e.message : `${e.delivery_code ?? "send_failed"}: ${e.message}` });
    }
    save();
    log(`配送 ${item.decision_id} → ${entry.state}${entry.result ? `/${entry.result}` : ""}`);
    if (entry.state === "report") await report(item.decision_id);
  }

  async function safeState(entry: Entry) {
    try { return await channelAnswerState(entry.channel_id, entry.delivery_id); } catch { return null; }
  }

  async function checkQueued() {
    for (const [id, entry] of Object.entries(journal)) {
      if (entry.state === "report") { await report(id); continue; }
      if (entry.state !== "queued") continue;
      const current = await safeState(entry);
      if (current === "emitted") Object.assign(entry, { state: "report", result: "delivered" });
      else if (current === "unknown") Object.assign(entry, { state: "report", result: "unknown", detail: "受け口の出力を確かめられませんでした" });
      else if (current === null || current === "withdrawn") Object.assign(entry, { state: "report", result: "failed", detail: "配送の記録が見つかりません" });
      else if (current === "queued") {
        const before = entry.orphaned_at;
        const giveUp = abandoned(entry, receiverOf(entry.channel_id));
        if (entry.orphaned_at !== before) save();
        if (!giveUp) continue;
        // 遅れて起動し直した会話が二重に受け取らないよう、未取得の本文を取り下げる。取られていたら次の確認で emitted/unknown を追う。
        if (!steer.withdrawFromChannel(PROFILE, entry.channel_id, entry.delivery_id)) continue;
        Object.assign(entry, { state: "report", result: "failed", detail: "申請を出したAIの会話が終わっています" });
      }
      else continue;
      save();
      log(`配送 ${id} → ${entry.result}`);
      await report(id);
    }
  }

  let syncing: Promise<void> | null = null;
  let again = false;
  async function sync() {
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      do {
        again = false;
        try {
          const { items } = await api.call<{ items: Delivery[] }>("GET", "/deliveries");
          const waiting = new Map(items.map(item => [item.decision_id, item]));
          for (const [id, entry] of Object.entries(journal)) {
            if (entry.state !== "queued") continue;
            const item = waiting.get(id);
            if (item && item.delivery_id === entry.delivery_id && item.route.channel_id === entry.channel_id) continue;
            // 再開/取得で配送先が変わった。未取得の本文だけ取り下げる。
            // 取り出しと競合した時は新しい会話へ二重に送らない。
            const withdrawn = steer.withdrawFromChannel(PROFILE, entry.channel_id, entry.delivery_id);
            if (withdrawn || !item) {
              delete journal[id];
              save();
              log(`配送 ${id} → ${withdrawn ? "withdrawn" : "resolved"}`);
            } else {
              Object.assign(entry, await safeState(entry) === "emitted"
                ? { state: "report", result: "delivered" }
                : { state: "report", result: "unknown", detail: "配送先の変更前に受け口が本文を取得しました。再送しません" });
              save();
              await report(id);
              // このsyncで取得した古い待ち一覧から送り直さない。
              waiting.delete(id);
            }
          }
          for (const item of waiting.values()) await deliver(item);
        } catch (error) {
          log(`配送待ちの取得に失敗: ${(error as Error).message}`);
        }
      } while (again);
    })();
    try { await syncing; } finally { syncing = null; }
  }

  const controller = new AbortController();
  let stopping = false;
  const releaseLock = () => {
    try {
      const lock = JSON.parse(readFileSync(lockFile(), "utf8")) as { pid: number };
      if (lock.pid === process.pid) rmSync(lockFile(), { force: true });
    } catch { /* 無ければよい */ }
  };
  // 止められたら、すぐ席（lock）を空ける。終わるまでの数秒の間に起こされた次のデーモン（待たない古い版も含む）が、
  // 「もう動いている」と見て終わってしまわないように。
  const stop = () => { stopping = true; releaseLock(); controller.abort(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  (async () => {
    let backoff = 1000;
    while (!stopping) {
      try {
        await api.stream(() => { backoff = 1000; void sync(); }, controller.signal);
      } catch (error) {
        if (stopping) break;
        log(`受信が切れました: ${(error as Error).message}`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  })();

  let idleSince = Date.now();
  let tick = 0;
  while (!stopping) {
    await sleep(2000);
    await checkQueued();
    if (++tick % 30 === 0) {
      await sync();
      // 待つものが無くなって30分たったら終わる。次の申請でMCPが起こし直す。
      try {
        const { items } = await api.call<{ items: { status: string }[] }>("GET", "/decisions");
        const open = items.some((d) => d.status === "pending" || d.status === "held");
        if (open || Object.keys(journal).length) idleSince = Date.now();
        else if (Date.now() - idleSince > IDLE_EXIT_MS) stop();
      } catch { idleSince = Date.now(); }
    }
  }
  releaseLock();
  process.exit(0);
}
