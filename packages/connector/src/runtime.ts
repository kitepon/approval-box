import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_FILES } from "./profile.ts";

/** いま動いているApproval Boxの置き場（ビルド済みの dist、または setup が複製した ~/.approval-box/runtime/<版>）。 */
export const runtimeDir = () => {
  // 束ねた後のコードは dist/chunks/ に入る。置き場はその一つ上。
  const dir = dirname(fileURLToPath(import.meta.url));
  return basename(dir) === "chunks" ? dirname(dir) : dir;
};

export function runtimeEntry(kind: keyof typeof HOOK_FILES | "cli"): string {
  return join(runtimeDir(), kind === "cli" ? "cli.mjs" : HOOK_FILES[kind]);
}
