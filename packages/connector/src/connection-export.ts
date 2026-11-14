import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { configFile } from "./config.ts";

export type ConnectionExport = { schema: "approval-box.connection.v1"; server: string; token: string };

/** Export the local connection through the public CLI without exposing its storage layout. */
export function exportConnection(): ConnectionExport {
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const file = resolve(configFile());
    if (realpathSync(file) !== file) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 65536) throw new Error();
    if (process.getuid && process.getgid && (before.uid !== process.getuid() || before.gid !== process.getgid()
      || (before.mode & 0o7777) !== 0o600)) throw new Error();
    bytes = Buffer.alloc(before.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    const config = JSON.parse(bytes.subarray(0, count).toString("utf8")) as { server?: unknown; token?: unknown } | null;
    if (typeof config?.server !== "string" || !config.server || config.server !== config.server.trim() || /[\r\n]/.test(config.server)
      || typeof config.token !== "string" || !config.token.trim() || /[\r\n]/.test(config.token)) throw new Error();
    const url = new URL(config.server);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return { schema: "approval-box.connection.v1", server: config.server.replace(/\/$/, ""), token: config.token };
  } catch {
    throw new Error("APPROVAL_BOX_CONNECTION_UNAVAILABLE");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}
