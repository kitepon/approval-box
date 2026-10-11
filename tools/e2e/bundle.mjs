#!/usr/bin/env node
// parent-e2e を、試験用サーバーと依存ごと1ファイルへ束ねる。repoを置かない端末（Windows・macOS）で実機試験を走らせるため。
// 使い方: node tools/e2e/bundle.mjs <出力先.mjs>
// 端末では: E2E_REGISTRATION=installed APPROVAL_BOX_HOME=<隔離した置き場> node <出力先.mjs> claude-code
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) { console.error("usage: bundle.mjs <出力先.mjs>"); process.exit(2); }
await build({
  entryPoints: [fileURLToPath(new URL("./parent-e2e.mjs", import.meta.url))],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: { js: "import { createRequire as __e2eCreateRequire } from 'node:module'; const require = __e2eCreateRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
