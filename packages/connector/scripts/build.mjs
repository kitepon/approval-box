// コネクタを依存ごと束ねる。setupはこの dist を ~/.approval-box/runtime/<版> へ複製し、hookとMCPはそこを指す。
import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = await build({
  metafile: true,
  entryPoints: {
    "cli": "src/cli.ts",
    "approval-box-claude-hook": "src/hooks/claude.ts",
    "approval-box-codex-hook": "src/hooks/codex.ts",
    "approval-box-cursor-hook": "src/hooks/cursor.ts",
    "approval-box-receive": "src/hooks/receive.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  chunkNames: "chunks/[name]-[hash]",
  banner: { js: "import { createRequire as __kbCreateRequire } from 'node:module'; const require = __kbCreateRequire(import.meta.url);" },
  define: { __APPROVAL_BOX_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(new URL("../dist/cli.mjs", import.meta.url), 0o755);

// 束ねた依存のライセンス文を dist に残す（MITなどは配布物にライセンス文を含める必要がある）。
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (!match) continue;
  const root = match[1];
  if (packages.has(root)) continue;
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const licenseFile = readdirSync(root).find((f) => /^(license|licence|copying)/i.test(f));
  packages.set(root, { name: meta.name, version: meta.version, license: meta.license, text: licenseFile ? readFileSync(join(root, licenseFile), "utf8").trim() : null });
}
const notices = ["# Third-party notices", "", "approval-box bundles the following packages.", ""];
for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  notices.push(`## ${p.name}@${p.version} (${p.license})`, "", p.text ? "```\n" + p.text + "\n```" : "(license text not shipped by the package)", "");
}
writeFileSync(new URL("../dist/THIRD_PARTY_NOTICES.md", import.meta.url), notices.join("\n"));
console.log(`built approval-box ${pkg.version}`);
