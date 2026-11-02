import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

// Run from repo root; derived docs have no content hash to avoid self-referential hashes.
const tracked = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const files = tracked.filter(p => /\.(?:ts|tsx|mjs|cjs|py|sh)$/.test(p));
const sources = [], routes = [], references = [], tests = [];
for (const path of files) {
  const text = readFileSync(path,'utf8');
  const entry = {path,sha256:createHash('sha256').update(text).digest('hex'),lines:text.split('\n').length-1,imports:[],symbols:[]};
  if (!/\.(?:py|sh)$/.test(path)) {
    const ast = ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
    const line = n => ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1;
    const visit = n => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) && n.moduleSpecifier) {
        const module=n.moduleSpecifier.text; entry.imports.push(module);
        references.push({caller:path,line:line(n),module,import:n.getText(ast)});
      }
      if ((ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n)||ts.isTypeAliasDeclaration(n)||ts.isInterfaceDeclaration(n)) && n.name) entry.symbols.push({name:n.name.getText(ast),kind:ts.SyntaxKind[n.kind],line:line(n)});
      if (ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)) {
        const owner=n.parent.name?.getText(ast) ?? 'object';
        entry.symbols.push({name:owner+'.'+(n.name?.getText(ast)??'constructor'),kind:ts.SyntaxKind[n.kind],line:line(n)});
      }
      if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))) entry.symbols.push({name:n.name.getText(ast),kind:'FunctionVariable',line:line(n)});
      if (ts.isCallExpression(n)) {
        if (ts.isPropertyAccessExpression(n.expression)) {
          const target=n.expression.expression.getText(ast),method=n.expression.name.text;
          if (['app','v1','conn','pairing'].includes(target)&&['get','post','put','patch','delete','on','all','use','route'].includes(method)) {
            const arg=n.arguments[method==='on'?1:0];
            routes.push({file:path,line:line(n),target,method,path:arg?.getText(ast),...(method==='on'?{methods:n.arguments[0].getText(ast)}:{})});
          }
        }
        if (n.expression.getText(ast)==='test') tests.push({file:path,line:line(n),label:n.arguments[0]?.getText(ast)});
      }
      ts.forEachChild(n,visit);
    };
    visit(ast);
  } else {
    for (const match of text.matchAll(/^(?:async\s+)?def\s+(\w+)|^(\w+)\(\)\s*\{/gm)) entry.symbols.push({name:match[1]??match[2],kind:'ScriptFunction',line:text.slice(0,match.index).split('\n').length});
  }
  sources.push(entry);
}
const json=(name,data)=>writeFileSync('docs/refactoring/final/'+name,JSON.stringify(data,null,2)+'\n');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
json('source-index.json',{sourceCommit,note:'All tracked executable sources and tests; static symbols/imports, not a control-flow proof.',files:sources});
json('interface-index.json',{sourceCommit,note:'Routes include middleware/mount/fallback; dynamic admin actions resolve/reopen and MCP handlers are described in flows.',routes,references,tests});
const productionRoutes=routes.filter(r=>r.file.startsWith('packages/server/src/'));
const baseline=JSON.parse(readFileSync('docs/refactoring/design/route-map.json','utf8')).routes;
const key=r=>JSON.stringify([r.target,r.method,r.resolved_path?JSON.stringify(r.resolved_path):r.path]);
assert.deepEqual(productionRoutes.map(key).sort(),baseline.map(key).sort(),'Every original registration must remain');
assert.equal(productionRoutes.length,72);
assert.equal(productionRoutes.find(r=>r.method==='on').methods, '["GET", "DELETE"]');
assert.ok(sources.some(f=>f.path==='tools/deploy/server-image-smoke.cjs'));
assert.ok(sources.some(f=>f.path==='packages/server/src/http/streams.ts'));
const md=['# 全実行ソースと関数の対応','',`source commit: ${sourceCommit}。hashを実ファイルと照合する。`, '', '全体図 → [機能別の責任](flows.md) → この索引。静的解析は動的呼出しや実行成功の証明とは区別する。',''];
for(const f of sources){md.push('## '+f.path,'',`sha256: ${f.sha256}`, '', 'import: '+(f.imports.join(', ')||'なし/非JS'),'');
 for(const s of f.symbols)md.push(`- [${s.name}](../../../${f.path}#L${s.line}) (${s.kind})`);
 if(!f.symbols.length)md.push('定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。');
 md.push('');}
writeFileSync('docs/refactoring/final/code-index.md',md.join('\n'));
const category=p=>p.startsWith('docs/')?'文書・図':p.includes('/test/')?'試験・fixture':p.startsWith('tools/')?'運用・試験tool':p.includes('/src/')?'製品実装':/LICENSE|NOTICES|certs\/|keyring|SHASUM/.test(p)?'license・検証資産':p.includes('/public/')||/\.(css|html|svg)$/.test(p)?'画面・公開資産':'構築・配布・設定';
const scope=['# 全追跡ファイルの対応','', 'git ls-filesを全件列挙。実行sourceは[関数索引](code-index.md)、運用・資産の責任と未実行条件は[補足](scope-notes.md)を参照。','','| ファイル | 責任分類 |','|---|---|'];
for(const p of tracked)scope.push(`| [${p}](../../../${p}) | ${category(p)} |`);
writeFileSync('docs/refactoring/final/scope.md',scope.join('\n')+'\n');
console.log(JSON.stringify({tracked:tracked.length,sources:sources.length,symbols:sources.reduce((n,f)=>n+f.symbols.length,0),productionRegistrations:productionRoutes.length,references:references.length,tests:tests.length}));
