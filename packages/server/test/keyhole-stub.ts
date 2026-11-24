// login-billing 0.21.1 ships no helper that signs a request for tests (dist/testing has none), and the wire format is the library's own:
// tests never hand-roll it. This stub stands in for verify() only, behind the same header; the real verify is covered for refusals.
import { KeyholeError, type KeyholeRequest } from "@kitepon/login-billing/server";
import type { AppKeyholes, Entries } from "../src/keyholes.ts";

/** Header value for the stub: `stub <entry> <key>`. */
export const signed = (entry: string, key: string) => ({ "login-billing-key": `stub ${entry} ${key}` });

/** verify() accepts `stub <entry> <key>`, anything else is key_invalid; every request it saw is kept. handle() is not stubbed. */
export function stubKeyholes(entries: Entries) {
  const seen: KeyholeRequest[] = [];
  const keyholes: AppKeyholes = {
    entries,
    async verify(request) {
      seen.push(request);
      const value = request.headers instanceof Headers ? request.headers.get("login-billing-key") : request.headers["login-billing-key"];
      const m = /^stub (\S+) (\S+)$/.exec(typeof value === "string" ? value : "");
      if (!m) throw new KeyholeError("key_invalid");
      return { entry: m[1]!, key: m[2]!, role: "parent" };
    },
    async handle() { throw new Error("not stubbed"); },
  };
  return { keyholes, seen };
}
