import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { home } from "./profile.ts";

/** CIMの子はSSHセッションのJobに所属させず、状態とCLI探索に必要な環境だけ渡す。 */
export function windowsDaemonLaunchScript(executable: string, entry: string, cwd: string, environment: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(["APPROVAL_BOX_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "CODEX_HOME", "GROK_HOME", "CODEX_BIN"].flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]]));
  const bootstrap = `Object.assign(process.env,${JSON.stringify(env)});const fs=require('node:fs');process.stderr.write=(text)=>{fs.appendFileSync(${JSON.stringify(join(cwd, "daemon.log"))},text);return true;};process.argv=[process.execPath,${JSON.stringify(entry)},'daemon'];import(require('node:url').pathToFileURL(${JSON.stringify(entry)}).href).catch(error=>{process.stderr.write(String(error)+'\\n');process.exit(1);});`;
  // 引数に埋め込むJSはbase64にし、ユーザーのpathをshellとして解釈させない。
  const command = `"${executable}" -e "eval(Buffer.from('${Buffer.from(bootstrap).toString("base64")}','base64').toString())"`;
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0};$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${literal(command)};CurrentDirectory=${literal(cwd)};ProcessStartupInformation=$startup};if($result.ReturnValue -ne 0){throw ('daemon creation failed: '+$result.ReturnValue)};$result.ProcessId`;
}

/** 常駐の起動はこのadapterが所有する。WindowsのSSH終了にも背景processを残す。 */
export function launchDaemon(executable: string, entry: string, cwd: string) {
  if (process.platform === "win32") {
    const script = windowsDaemonLaunchScript(executable, entry, cwd, { ...process.env, APPROVAL_BOX_HOME: resolve(home()) });
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd, windowsHide: true, encoding: "utf8", timeout: 15_000 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("PowerShell 7（pwsh.exe）が見つかりません。標準PATHにPowerShell 7を導入してください。");
    if (result.error || result.status !== 0 || !/^\s*\d+\s*$/.test(result.stdout ?? "")) throw new Error(`Windowsの常駐起動に失敗しました（${result.error?.message ?? `exit ${result.status}`}）`);
    return;
  }
  const log = openSync(join(cwd, "daemon.log"), "a", 0o600);
  try { spawn(executable, [entry, "daemon"], { cwd, detached: true, stdio: ["ignore", "ignore", log], windowsHide: true }).unref(); }
  finally { closeSync(log); }
}
