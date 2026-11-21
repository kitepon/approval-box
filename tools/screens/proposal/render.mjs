// Builds the proposal mock HTML files (self-contained) and renders them to PNG.
// Source of the texts: docs/architecture/screens.md. Run: node tools/screens/proposal/render.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/srv/bellteam/bots/bot-4366a50b/repos/approval-box/package.json");
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "docs", "screenshots", "proposal");
mkdirSync(outDir, { recursive: true });

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","IPAGothic","IPAPGothic",system-ui,sans-serif;color:#1c1c1e;background:#f2f2f7;font-size:15px;line-height:1.55}
.app{min-height:100vh;display:flex;flex-direction:column}
.page{flex:1;padding:20px 18px 24px;display:flex;flex-direction:column;gap:14px}
h1{font-size:26px;font-weight:700;letter-spacing:.01em}
h2{font-size:13px;font-weight:600;color:#6c6c70;margin:10px 4px 6px}
.sub{color:#48484a}
.btn{display:block;width:100%;text-align:center;border-radius:12px;padding:14px 16px;font-size:16px;font-weight:600;border:1px solid transparent}
.btn.primary{background:#0a6cff;color:#fff}
.btn.apple{background:#000;color:#fff}
.btn.second{background:#fff;color:#0a6cff;border-color:#c7c7cc}
.btn.small{display:inline-block;width:auto;padding:9px 16px;font-size:14px}
.btn.disabled{background:#d1d1d6;color:#8e8e93}
.btn.ghost{background:transparent;color:#0a6cff;border-color:transparent}
.btn.danger{background:#fff;color:#d70015;border-color:#c7c7cc}
.note{font-size:12px;color:#6c6c70;text-align:center}
.card{background:#fff;border-radius:14px;padding:14px 16px}
.list{background:#fff;border-radius:14px;overflow:hidden}
.row{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-top:1px solid #e5e5ea;gap:10px}
.row:first-child{border-top:0}
.row .chev{color:#c7c7cc;font-size:18px}
.row.red{color:#d70015}
.row .val{color:#6c6c70}
.row .act{color:#0a6cff;font-size:14px}
.row .act.red{color:#d70015}
.sw{width:46px;height:28px;border-radius:14px;background:#34c759;position:relative;flex:none}
.sw::after{content:"";position:absolute;right:3px;top:3px;width:22px;height:22px;border-radius:50%;background:#fff}
.sel{border:1px solid #c7c7cc;border-radius:8px;padding:5px 12px;background:#fff;color:#1c1c1e;font-size:14px}
details{background:#fff;border-radius:14px;padding:14px 16px}
summary{font-weight:600;list-style:none;display:flex;justify-content:space-between}
summary::after{content:"\\2304";color:#6c6c70}
details[open] summary::after{content:"\\2303"}
details ol{margin:12px 0 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:12px;font-size:14px}
details ol li{display:flex;gap:8px}
details ol li b{flex:none;width:20px;color:#0a6cff}
.cmd{margin:8px 0;background:#1c1c1e;color:#e5e5ea;font-family:ui-monospace,"DejaVu Sans Mono",monospace;font-size:12px;border-radius:8px;padding:10px 12px}
.links{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;font-size:13px;color:#0a6cff}
.banner{background:#fff4e5;border:1px solid #ffcc80;color:#7a4b00;border-radius:12px;padding:12px 14px;font-size:14px}
.chips{display:flex;gap:8px}
.chip{padding:6px 16px;border-radius:16px;background:#e5e5ea;font-size:14px}
.chip.on{background:#0a6cff;color:#fff}
.search{background:#e5e5ea;border-radius:10px;padding:9px 14px;color:#8e8e93}
.qr{width:200px;height:200px;margin:4px auto;background:#c7c7cc;color:#fff;font-size:34px;font-weight:700;display:flex;align-items:center;justify-content:center;border-radius:10px}
.code{font-family:ui-monospace,"DejaVu Sans Mono",monospace;font-size:28px;font-weight:700;letter-spacing:.06em}
.kv{text-align:center}
.kv small{display:block;font-size:12px;color:#6c6c70}
.status{font-size:17px;font-weight:600}
.status small{display:block;font-size:14px;font-weight:400;color:#48484a;margin-top:2px}
.tabbar{display:flex;background:#fff;border-top:1px solid #d1d1d6;padding:8px 4px 22px}
.tab{flex:1;text-align:center;font-size:12px;color:#8e8e93;padding-top:6px;position:relative}
.tab::before{content:"";display:block;width:22px;height:4px;border-radius:2px;margin:0 auto 5px;background:transparent}
.tab.on{color:#0a6cff;font-weight:600}
.tab.on::before{background:#0a6cff}
.badge{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:#ff3b30;color:#fff;font-size:11px;line-height:18px;margin-left:3px;vertical-align:1px}
.wide{display:flex;min-height:100vh}
.side{width:220px;background:#fff;border-right:1px solid #d1d1d6;padding:24px 12px;display:flex;flex-direction:column;gap:4px}
.side .item{padding:10px 14px;border-radius:10px;color:#3a3a3c;font-size:15px}
.side .item.on{background:#e6f0ff;color:#0a6cff;font-weight:600}
.side .brand{font-weight:700;font-size:16px;padding:0 14px 16px}
.main{flex:1;padding:24px 40px;overflow:hidden}
.main .page{max-width:620px;padding:0 0 24px}
`;

const html = (body, title) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>
`;

const TABS = ["受信", "履歴", "接続", "設定"];
const tabbar = (on, badge) =>
  `<nav class="tabbar">${TABS.map((t) => `<div class="tab${t === on ? " on" : ""}">${t}${t === "受信" && badge ? `<span class="badge">${badge}</span>` : ""}</div>`).join("")}</nav>`;
const phone = (page, tab, badge) => `<div class="app"><main class="page">${page}</main>${tab ? tabbar(tab, badge) : ""}</div>`;

const LEGAL = `<div class="links"><span>利用規約</span><span>プライバシーポリシー</span><span>特定商取引法に基づく表記</span></div>`;
const RENEW = `<p class="note">1か月ごとの自動更新。解約は、契約したストアの管理画面から行えます。</p>`;
const CMD = `<div class="cmd">（PCで実行するコマンド）</div><span class="btn second small">コマンドをコピー</span>`;

const hero = `<div><h1>Approval Box</h1><p class="sub" style="margin-top:6px">AIの相談に、スマホやPCから答えます。</p></div>`;
const disclosure = (open) => `<details${open ? " open" : ""}><summary>はじめての方へ</summary><ol>
<li><b>1.</b><span>iPhone・iPad・Mac または Android の決裁箱で、Apple または Google でログインし、設定 → 契約 から契約します。</span></li>
<li><b>2.</b><span>PCでコマンドを実行して、AIとつなぎます。${CMD}</span></li>
<li><b>3.</b><span>ほかの端末（Linux・ブラウザ・もう一方のスマホ）は、この画面の「スマホの承認でログイン」を押し、契約したスマホの 設定 → ほかの端末をログインさせる で承認します。</span></li></ol></details>`;
const loginFoot = `<div class="links"><span>利用規約</span><span>プライバシーポリシー</span><span>サポート</span></div>
<div class="row" style="background:#fff;border-radius:14px"><span>言語</span><span class="sel">日本語</span></div>`;
const login = ({ apple, open, banner }) =>
  (banner ? `<div class="banner">${banner}</div>` : "") + hero +
  (apple ? `<div class="btn apple">Appleでログイン</div><div class="btn second">スマホの承認でログイン</div>` : `<div class="btn primary">スマホの承認でログイン</div>`) +
  disclosure(open) + loginFoot;

const handoff = `<h1>スマホの承認を待っています</h1>
<div class="card kv"><div class="qr">QR</div>
<div style="margin-top:12px"><small>ログインコード</small><div class="code">K7QM-4PZD</div></div>
<div style="margin-top:8px"><small>確認番号</small><div class="code">37</div></div>
<p class="note" style="margin-top:8px">12:45まで有効</p></div>
<p>契約したスマホの決裁箱で、設定 → ほかの端末をログインさせる を開き、このQRを読むか、コードを入力してください。確認番号が同じなら「許可する」を押します。</p>
<div class="btn second">やめる</div>`;

const plan = (statusHtml, block, logout) =>
  `<h1>契約</h1><div class="card status">${statusHtml}</div>${block}${RENEW}${LEGAL}${logout ? `<div class="btn danger">ログアウト</div>` : ""}`;

const canBuyBefore = `<div class="card"><p style="font-weight:600">契約の前に、AIとつながっているか確かめます。</p>
<div style="margin-top:12px"><p>1. 接続テストの申請に答える</p><div class="btn primary small" style="margin-top:8px">接続テストの申請を開く</div></div>
<div style="margin-top:14px"><p>2. 契約する</p></div></div>
<div><div class="btn disabled">1か月無料で試す（その後 ¥500 / 月）</div><p class="note" style="margin-top:6px">手順1のあとに押せます。</p></div>
<div class="btn ghost">購入を復元</div>`;
const cannotBuy = `<div class="card"><p>この端末では契約できません。契約は、iPhone・iPad・Mac または Android の決裁箱で、設定 → 契約 から行います。</p></div>`;
const handoffActive = `<div class="card"><p>この端末は、契約しているスマホの承認でログインしています。</p></div>`;

const sec = (h, rows) => `<h2>${h}</h2><div class="list">${rows}</div>`;
const r = (l, right = `<span class="chev">›</span>`, cls = "") => `<div class="row ${cls}"><span>${l}</span>${right}</div>`;
const settingsBody = `<h1>設定</h1>
${sec("アカウント", r("Appleでログインしています", ""))}
${sec("契約", `<div class="row"><span class="status" style="font-size:15px">契約中（App Store）<small>期限: 2026/12/21</small></span></div>` + r("契約について"))}
${sec("ほかの端末", r("ほかの端末をログインさせる") + r("ログインさせた端末", "") + r("作業用PC", `<span class="act red">停止</span>`) + r("ほかの端末をすべて停止", "", "red"))}
${sec("通知", r("通知", `<span class="sw"></span>`))}
${sec("言語", r("言語", `<span class="sel">日本語</span>`))}
${sec("履歴の保存", r("保存期間") + r("履歴を削除", "", "red"))}
${sec("ヘルプ", r("使い方・お問い合わせ") + r("利用規約") + r("プライバシーポリシー"))}
${sec("アカウント管理", r("保存されている情報の写しを受け取る") + r("ログアウト", "", "red") + r("アカウントと全データを削除", "", "red"))}`;

const inbox = `<h1>受信</h1><div class="chips"><span class="chip on">すべて</span><span class="chip">未回答</span><span class="chip">保留</span></div>
<div class="search">相談を検索</div>
<div class="list">${r("本番へ配備してよいか")}${r("請求書のPDFを確認してほしい")}</div>`;

const wide = `<div class="wide"><aside class="side"><div class="brand">Approval Box</div>${TABS.map((t) => `<div class="item${t === "設定" ? " on" : ""}">${t}${t === "受信" ? `<span class="badge">2</span>` : ""}</div>`).join("")}</aside><section class="main"><div class="page">${settingsBody}</div></section></div>`;

const mocks = [
  ["01-login-iphone", phone(login({ apple: true, open: true })), 390, 844],
  ["02-login-linux-web", phone(login({ apple: false, open: false })), 390, 844],
  ["03-login-banner", phone(login({ apple: true, open: false, banner: "この端末のログインは、承認したスマホから止められました。もう一度ログインしてください。" })), 390, 844],
  ["04-handoff-wait", phone(handoff), 390, 844],
  ["05-plan-can-buy-before-setup", phone(plan(`未契約`, canBuyBefore), "設定"), 390, 844],
  ["06-plan-cannot-buy", phone(plan(`未契約`, cannotBuy, true), "設定"), 390, 844],
  ["07-plan-active-handoff", phone(plan(`契約中（Google Play）<small>期限: 2026/12/21</small>`, handoffActive), "設定"), 390, 844],
  ["08-settings", phone(settingsBody, "設定", 2), 390, 844],
  ["08-settings-wide", wide, 1280, 800],
  ["09-inbox", phone(inbox, "受信", 2), 390, 844],
];

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
for (const [name, body, w, h] of mocks) {
  writeFileSync(join(here, `${name}.html`), html(body, name));
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, locale: "ja-JP" });
  const page = await ctx.newPage();
  await page.goto(`file://${join(here, `${name}.html`)}`);
  // 08-settings is a long page: full page. Wide mock is a fixed 1280x800 frame.
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: name !== "08-settings-wide" });
  const dims = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
  console.log(name, dims.join("x"));
  await ctx.close();
}
await browser.close();
