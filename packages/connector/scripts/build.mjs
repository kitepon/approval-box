// コネクタを依存ごと束ねる。setupはこの dist を ~/.kessaibako/runtime/<版> へ複製し、hookとMCPはそこを指す。
import { build } from "esbuild";
import { readFileSync, rmSync, chmodSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: {
    "cli": "src/cli.ts",
    "kessaibako-claude-hook": "src/hooks/claude.ts",
    "kessaibako-codex-hook": "src/hooks/codex.ts",
    "kessaibako-cursor-hook": "src/hooks/cursor.ts",
    "kessaibako-receive": "src/hooks/receive.ts",
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
  define: { __KESSAIBAKO_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "linked",
  logLevel: "warning",
});
chmodSync(new URL("../dist/cli.mjs", import.meta.url), 0o755);
console.log(`built kessaibako ${pkg.version}`);
