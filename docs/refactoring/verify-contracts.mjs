import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import ts from 'typescript';
const base='90066748bf7ca4686716c67c91d76fcd20afa519';
const old=p=>execFileSync('git',['show',base+':'+p],{encoding:'utf8'});
const node=(text,name)=>{const ast=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);let found;function visit(n){if(n.name?.getText(ast)===name&&n.body)found=n.body.getText(ast);ts.forEachChild(n,visit)}visit(ast);assert.ok(found,name);return found;};
const checks=[];
for(const name of ['body','bearer','idempotent','fileResponse']){
 assert.equal(node(readFileSync('packages/server/src/http/common.ts','utf8'),name),node(old('packages/server/src/http.ts'),name));checks.push('HTTP helper body unchanged: '+name);
}
for(const name of ['harnessOf','channelFor','savedParents','reuse','remember']){
 assert.equal(node(readFileSync('packages/connector/src/parent-channels.ts','utf8'),name),node(old('packages/connector/src/mcp.ts'),name));checks.push('Parent branch body unchanged: '+name);
}
assert.equal(node(readFileSync('packages/connector/src/mcp.ts','utf8'),'runMcp'),node(old('packages/connector/src/mcp.ts'),'runMcp'));checks.push('MCP complete handler/schema use unchanged');
for(const f of ['locales.ts','error-messages-en.ts','error-messages-east-asian.ts']){
 assert.equal(readFileSync('packages/server/src/shared/'+f,'utf8'),old('packages/server/src/'+f));checks.push('Moved bytes unchanged: '+f);
}
assert.equal(node(readFileSync('packages/server/src/shared/error-translations.ts','utf8'),'fixedErrorTranslation'),node(old('packages/server/src/errors.ts'),'fixedErrorTranslation'));checks.push('Fixed translation lookup order unchanged');
const files=JSON.parse(readFileSync('docs/refactoring/final/source-index.json','utf8')).files;
for(const f of files)for(const symbol of f.symbols)assert.ok(symbol.line>=1&&symbol.line<=f.lines+1,f.path);
writeFileSync('docs/refactoring/final/contract-check.json',JSON.stringify({base,checks,productionChanges:'SSE error/abort cleanup is an intentional behavior fix in 9b55bf6, excluded from equality checks.'},null,2)+'\n');
console.log(checks.length+' preservation checks passed');
