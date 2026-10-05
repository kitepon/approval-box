import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const root = mkdtempSync(join(tmpdir(), 'ab-mcp-routing-'));
const routes = []; const clients = [];
const server = createServer((req, res) => {
  if (req.url.endsWith('/stream')) { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('event: ready\ndata: {}\n\n'); return; }
  let body = ''; req.on('data', x => body += x); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/amend')) {
      routes.push(JSON.parse(body).route);
      res.end(JSON.stringify({decision_id:'K-SMOKE',title:'test',status:'pending',version:2}));
    } else if (req.method === 'POST' && req.url.endsWith('/resume')) {
      routes.push(JSON.parse(body));
      res.end(JSON.stringify({decision_id:'K-SMOKE',title:'test',status:'pending',version:3}));
    } else res.end('{"items":[]}');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(root,'config.json'), JSON.stringify({server:`http://127.0.0.1:${server.address().port}`,token:'isolated'}), {mode:0o600});
const cli = process.argv[2] ?? fileURLToPath(new URL('../../packages/connector/dist/cli.mjs', import.meta.url));
try {
  for (const tool of ['amend_decision','resume_decision']) {
    const client = new Client({name:'grok',version:'test'}); clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp'],env:{...process.env,APPROVAL_BOX_HOME:root},stderr:'pipe'}));
    const tools = await client.listTools(); assert.ok(tools.tools.some(x => x.name === 'resume_decision'));
    const result = await client.callTool({name:tool,arguments:tool === 'amend_decision' ? {decision_id:'K-SMOKE',version:1,note:'resume',changes:{context:'updated'}} : {decision_id:'K-SMOKE'}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.steer_channel.channel_id, routes.at(-1).channel_id);
    assert.match(result.content[0].text, /背景プロセス/);
  }
  assert.notEqual(routes[0].channel_id, routes[1].channel_id);
  console.log('PASS: bundled MCP amendment and explicit resume resolve different parent channels and return receive guides');
} finally {
  for (const client of clients) await client.close();
  const lock = join(root,'state','daemon.json');
  if (existsSync(lock)) { try { process.kill(JSON.parse(readFileSync(lock,'utf8')).pid, 'SIGKILL'); } catch {} }
  server.closeAllConnections(); server.close(); rmSync(root,{recursive:true,force:true});
}
