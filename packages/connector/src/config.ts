import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "./profile.ts";

export type Config = { server: string; token?: string; connection_id?: string; device_name?: string };

export const OFFICIAL_SERVER = "https://approval-box.kitepon.dev";
export const configFile = () => join(home(), "config.json");

export function readConfig(): Config | null {
  if (!existsSync(configFile())) return null;
  return JSON.parse(readFileSync(configFile(), "utf8")) as Config;
}

export function requireConfig(): Config & { token: string } {
  const config = readConfig();
  if (!config?.token) throw new Error("Approval Boxにつながっていません。npx approval-box setup を実行してください。");
  return config as Config & { token: string };
}

const RENAME_RETRY = { attempts: 30, step_ms: 100 };
/**
 * Windowsでは、別のprogram（設定を書き換え中のClaude Code、検査中のウイルス対策）が開いている間、置き換えのrenameが EPERM/EACCES/EBUSY で
 * 断られる。すぐ諦めずに短く待って繰り返す（graceful-fsと同じ考え）。foxの .claude.json で0.1.28〜0.1.31のsetupが毎回この一回で止まっていた。
 */
export function renameWithRetry(from: string, to: string, rename: (from: string, to: string) => void = renameSync, retryable = process.platform === "win32", wait: (ms: number) => void = sleepSync) {
  for (let attempt = 1; ; attempt++) {
    try { rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!retryable || attempt >= RENAME_RETRY.attempts || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        if (retryable && code && ["EPERM", "EACCES", "EBUSY"].includes(code)) (error as Error).message += `（${to} を別のprogramが開いています。Claude Code等を閉じてから、もう一度実行してください）`;
        throw error;
      }
      wait(RENAME_RETRY.step_ms * attempt);
    }
  }
}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeJsonFile(file: string, value: unknown, options: { discardTemporaryOnError?: boolean } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameWithRetry(temp, file);
  } catch (error) {
    // 一度だけ取得する資格や結果不明のjournalは、復旧用tempを残す。
    if (options.discardTemporaryOnError) {
      try { rmSync(temp, { force: true }); }
      catch { process.stderr.write("approval-box: 保存に失敗した一時ファイルを回収できませんでした。\n"); }
    }
    throw error;
  }
}

export function writeConfig(config: Config) {
  writeJsonFile(configFile(), config);
}
