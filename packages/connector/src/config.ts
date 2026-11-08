import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
 * Windowsの一時的な置換拒否を短く再試行する。保護機能の恒久的な拒否も同じcodeなので、原因をロックと断定しない。
 */
export function renameWithRetry(from: string, to: string, rename: (from: string, to: string) => void = renameSync, retryable = process.platform === "win32", wait: (ms: number) => void = sleepSync) {
  for (let attempt = 1; ; attempt++) {
    try { rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!retryable || attempt >= RENAME_RETRY.attempts || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        if (retryable && code && ["EPERM", "EACCES", "EBUSY"].includes(code)) (error as Error).message += `（${to} の置き換えが拒否されました。権限、保護機能、他のprogramによる使用を確認してください）`;
        throw error;
      }
      wait(RENAME_RETRY.step_ms * attempt);
    }
  }
}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Renameを拒むWindows保護機能向け。Claudeの再生成可能な登録設定だけが使う。 */
export function writeJsonFileInPlace(file: string, value: unknown, expected: string | null) {
  const next = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const fd = openSync(file, expected === null ? "wx" : "r+", 0o600);
  let backup: string | undefined;
  let modified = false;
  const sameFile = () => {
    const current = statSync(file), opened = fstatSync(fd);
    return current.dev === opened.dev && current.ino === opened.ino;
  };
  const overwrite = (bytes: Buffer) => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error("設定ファイルへの書込みが進みませんでした。");
      offset += written;
    }
    fsyncSync(fd);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  };
  try {
    if (expected !== null) {
      if (!sameFile() || readFileSync(fd, "utf8") !== expected || readFileSync(file, "utf8") !== expected) {
        throw new Error("設定が別のprogramによって変更されました。最新の設定を読み直してから再実行してください。");
      }
      const recovery = `${file}.approval-box-restore-${randomUUID()}`;
      const saved = openSync(recovery, "wx", 0o600);
      backup = recovery;
      try { writeFileSync(saved, expected); fsyncSync(saved); }
      finally { closeSync(saved); }
      // 控えの保存中に変更された設定を上書きしない。
      if (!sameFile() || readFileSync(file, "utf8") !== expected) throw new Error("設定が保存中に変更されました。再実行してください。");
    }
    modified = true;
    overwrite(next);
    if (!sameFile() || !readFileSync(file).equals(next)) throw new Error("設定の保存結果が一致しません。");
  } catch (error) {
    if (modified) {
      try {
        if (!sameFile()) throw new Error("設定ファイルが差し替えられました。");
        if (expected === null) rmSync(file);
        else {
          overwrite(Buffer.from(expected));
          if (readFileSync(file, "utf8") !== expected) throw new Error("設定の復元結果が一致しません。");
        }
      } catch {
        const recovery = backup;
        backup = undefined;
        throw new Error(`設定の保存と復元に失敗しました。${recovery ? `元の内容の控え: ${recovery}` : "作成途中の設定ファイルを確認してください。"}`, { cause: error });
      }
    }
    throw error;
  } finally {
    closeSync(fd);
    if (backup) rmSync(backup);
  }
}

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
