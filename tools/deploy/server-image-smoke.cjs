const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const dir = '/tmp/sec021-isolated';
  fs.mkdirSync(dir, { recursive: true });
  let output = '';
  const child = spawn('/app/start-with-secrets.sh', [process.execPath, 'server/dist/main.js'], {
    env: { ...process.env, PORT: '18787', PUBLIC_URL: 'http://127.0.0.1:18787', APPROVAL_BOX_DATA: dir, BILLING: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const results = [];
  try {
    let started = false;
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch('http://127.0.0.1:18787/healthz')).status === 200) { started = true; break; } } catch {}
      await delay(100);
    }
    if (!started) throw new Error('isolated_start_failed');
    for (const [path, method, expected] of [
      ['/healthz', 'GET', 200], ['/privacy', 'GET', 200], ['/support', 'GET', 200],
      ['/v1/me', 'GET', 401], ['/connector/v1/decisions/pairing', 'GET', 401],
      ['/mcp', 'POST', 401],
    ]) {
      const response = await fetch('http://127.0.0.1:18787' + path, {
        method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
      });
      await response.text();
      results.push({ path, method, expected, status: response.status });
      if (response.status !== expected) throw new Error('isolated_status_mismatch');
    }
  } finally {
    child.kill('SIGTERM');
  }
  const exit = await Promise.race([closed, delay(8000).then(() => ({ timeout: true }))]);
  if (exit.timeout) child.kill('SIGKILL');
  console.log(JSON.stringify({ node: process.version, uid: process.getuid(), arch: process.arch,
    glibc: process.report.getReport().header.glibcVersionRuntime,
    nodeExecutableSha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    results, exit, data: 'fresh tmpfs only; no production volume or secrets', log: output }, null, 2));
  if (exit.code !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
