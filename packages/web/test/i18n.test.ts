import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocale, translate, setLanguage, locale } from "../src/i18n.ts";
import { en } from "../src/messages.ts";
import { ko, zhHans, zhHant } from "../src/messages-east-asian.ts";
import { ago, URGENCY_LABEL, deadlineText } from "../src/format.ts";

test("language priority, regional variants and unsupported fallback", () => {
  assert.equal(resolveLocale("en", ["ja-JP"]), "en");
  assert.equal(resolveLocale("system", ["fr-FR", "en-GB", "ja-JP"]), "en");
  assert.equal(resolveLocale("system", ["ja-JP", "en"]), "ja");
  assert.equal(resolveLocale("system", ["fr", "de"]), "ja");
  assert.equal(resolveLocale("system", []), "ja");
});
test("all catalogs have identical keys and interpolation tokens", () => {
  const tokens = (s: string) => [...s.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
  for (const catalog of [en, ko, zhHans, zhHant]) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    for (const [ja, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), ja);
      assert.deepEqual(tokens(ja), tokens(translated), ja);
    }
  }
});
test("user names with replacement syntax, markup and Japanese remain literal", () => {
  const name = "旦那 $& <script> {count}";
  assert.equal(translate("en", "{name}を外す", { name }), `Remove ${name}`);
  assert.equal(translate("ja", "{name}を外す", { name }), `${name}を外す`);
});
test("labels and plural time formatting follow language changes with unavailable storage", () => {
  setLanguage("en"); assert.equal(locale(), "en"); assert.equal(URGENCY_LABEL.high, "Urgent");
  assert.equal(ago(new Date(Date.now() - 61_000).toISOString()), "1 minute ago");
  assert.equal(ago(new Date(Date.now() - 121_000).toISOString()), "2 minutes ago");
  assert.match(deadlineText(new Date(Date.now() + 120_000).toISOString()), /in 2 minutes/);
  setLanguage("ja"); assert.equal(URGENCY_LABEL.high, "急ぎ");
  assert.match(ago(new Date(Date.now() - 61_000).toISOString()), /1 分前/);
});

test("visible Japanese literals outside the catalog must use a translation key", async () => {
  const ts = (await import("typescript")).default;
  const { readFileSync, readdirSync } = await import("node:fs");
  const root = new URL("../src/", import.meta.url);
  const files = [...readdirSync(root).filter(f => /\.tsx?$/.test(f) && !f.startsWith("messages") && f !== "i18n.ts"), ...readdirSync(new URL("pages/", root)).map(f=>"pages/"+f)];
  const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const missing: string[] = [];
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file,root),"utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: import("typescript").Node) {
      if (ts.isCallExpression(node) && ["t","labels"].includes(node.expression.getText(ast))) return;
      if ((ts.isStringLiteral(node) && japanese.test(node.text)) || (ts.isJsxText(node) && japanese.test(node.text) && !["日本語","한국어","简体中文","繁體中文"].includes(node.text.trim()))) missing.push(file+": "+node.getText(ast));
      if (ts.isTemplateExpression(node) && japanese.test(node.getText(ast))) missing.push(file+": "+node.getText(ast));
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  assert.deepEqual(missing,[]);
});

test("Korean and Chinese scripts/regions resolve in preference order and retain literal user text", () => {
  for (const [tag, expected] of [["ko-KR","ko"],["zh","zh-Hans"],["zh-CN","zh-Hans"],["zh-SG","zh-Hans"],["zh-TW","zh-Hant"],["zh-HK","zh-Hant"],["zh-MO","zh-Hant"],["zh-Hans-TW","zh-Hans"],["zh-Hant-CN","zh-Hant"]] as const) {
    assert.equal(resolveLocale("system",["fr",tag,"en"]),expected);
  }
  assert.equal(translate("ko","設定"),"설정");
  assert.equal(translate("zh-Hans","設定"),"设置");
  assert.equal(translate("zh-Hant","設定"),"設定");
  for(const language of ["ko","zh-Hans","zh-Hant"] as const) {
    assert.ok(translate(language,"{name}を外す",{name:"原文 $& <tag> {count}"}).includes("原文 $& <tag> {count}"));
  }
});
