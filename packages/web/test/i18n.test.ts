import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocale, translate, setLanguage, locale } from "../src/i18n.ts";
import { en } from "../src/messages.ts";
import { ago, URGENCY_LABEL, deadlineText } from "../src/format.ts";

test("language priority, regional variants and unsupported fallback", () => {
  assert.equal(resolveLocale("en", ["ja-JP"]), "en");
  assert.equal(resolveLocale("system", ["fr-FR", "en-GB", "ja-JP"]), "en");
  assert.equal(resolveLocale("system", ["ja-JP", "en"]), "ja");
  assert.equal(resolveLocale("system", ["fr", "de"]), "ja");
  assert.equal(resolveLocale("system", []), "ja");
});
test("all catalog messages have identical interpolation tokens in both languages", () => {
  const tokens = (s: string) => [...s.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
  for (const [ja, english] of Object.entries(en)) {
    assert.ok(english.trim(), ja);
    assert.deepEqual(tokens(ja), tokens(english), ja);
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
  const files = [...readdirSync(root).filter(f => /\.tsx?$/.test(f) && !["messages.ts", "i18n.ts"].includes(f)), ...readdirSync(new URL("pages/", root)).map(f=>"pages/"+f)];
  const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const missing: string[] = [];
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file,root),"utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: import("typescript").Node) {
      if (ts.isCallExpression(node) && ["t","labels"].includes(node.expression.getText(ast))) return;
      if ((ts.isStringLiteral(node) && japanese.test(node.text)) || (ts.isJsxText(node) && japanese.test(node.text) && node.text.trim()!=="日本語")) missing.push(file+": "+node.getText(ast));
      if (ts.isTemplateExpression(node) && japanese.test(node.getText(ast))) missing.push(file+": "+node.getText(ast));
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  assert.deepEqual(missing,[]);
});
