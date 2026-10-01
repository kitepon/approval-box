import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function writeJsonFile(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function writeConfig(config: Config) {
  writeJsonFile(configFile(), config);
}
