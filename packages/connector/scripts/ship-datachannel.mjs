// node-datachannel (peer-channel mode, c8c) beside the bundle: the JS package, detect-libc, and the prebuilt binaries for
// linux-x64, linux-arm64, darwin-x64, darwin-arm64 and win32-x64 as node-datachannel publishes them (@node-datachannel/<platform>).
// They go to dist/native/ (npm never packs a node_modules folder); installRuntime renames it to <runtime>/node_modules, where the
// bundle's lazy import("node-datachannel") resolves. The platform packages are fetched from the npm registry at the lockfile's URL
// and must match its sha512 integrity; they are cached in node_modules/.cache. Prints size and sha256 of every shipped binary.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["linux-x64-gnu", "linux-arm64-gnu", "darwin-x64", "darwin-arm64", "win32-x64-msvc"];
const root = fileURLToPath(new URL("../../../", import.meta.url));
const native = fileURLToPath(new URL("../dist/native/", import.meta.url));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const cache = join(root, "node_modules", ".cache", "approval-box-native");

export async function shipDataChannel() {
  rmSync(native, { recursive: true, force: true });
  mkdirSync(join(native, "@node-datachannel"), { recursive: true });
  for (const name of ["node-datachannel", "detect-libc"]) {
    const from = join(root, "node_modules", name);
    const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
    if (pkg.version !== lock.packages[`node_modules/${name}`].version) throw new Error(`${name} ${pkg.version} is not the locked version`);
    cpSync(from, join(native, name), { recursive: true, filter: (f) => !/[\\/](src|test|node_modules|build)([\\/]|$)/.test(f.slice(from.length)) });
  }
  mkdirSync(cache, { recursive: true });
  const shipped = [];
  for (const platform of PLATFORMS) {
    const entry = lock.packages[`node_modules/@node-datachannel/${platform}`];
    if (!entry?.resolved || !entry.integrity) throw new Error(`@node-datachannel/${platform} is not in package-lock.json`);
    const file = join(cache, `${platform}-${entry.version}.tgz`);
    if (!existsSync(file)) {
      const response = await fetch(entry.resolved, { redirect: "error" });
      if (!response.ok) throw new Error(`@node-datachannel/${platform}: HTTP ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    const tgz = readFileSync(file);
    if (`sha512-${createHash("sha512").update(tgz).digest("base64")}` !== entry.integrity) { rmSync(file); throw new Error(`@node-datachannel/${platform}: integrity mismatch`); }
    const unpack = mkdtempSync(join(cache, "unpack-")); // same filesystem as dist, so the rename below works
    const r = spawnSync("tar", ["-xzf", file, "-C", unpack]);
    if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
    renameSync(join(unpack, "package"), join(native, "@node-datachannel", platform));
    rmSync(unpack, { recursive: true, force: true });
    const dir = join(native, "@node-datachannel", platform);
    const binary = readdirSync(dir, { recursive: true }).map(String).find((f) => f.endsWith(".node"));
    if (!binary) throw new Error(`@node-datachannel/${platform}: no .node binary`);
    const bytes = readFileSync(join(dir, binary));
    shipped.push({ platform, version: entry.version, tgz_bytes: statSync(file).size, binary, binary_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  writeFileSync(join(native, "SHIPPED.json"), `${JSON.stringify(shipped, null, 2)}\n`);
  for (const s of shipped) console.log(`native ${s.platform} ${s.version}: ${s.binary} ${s.binary_bytes} bytes sha256 ${s.sha256}`);
  return shipped;
}
