#!/usr/bin/env python3
"""Approval Box's Caddy block: a request from the tunnel (cloudflared, 172.18.0.0/16) goes to the server with
X-Forwarded-For = Cloudflare's CF-Connecting-IP, so the library's per-caller limits count the real client
(login-billing audit, contract 1.34, 2026-11-23). Other virtual hosts are unchanged. Validates and reloads
Caddy; restores the previous file on failure. Run on main-server."""
from pathlib import Path
import shutil, subprocess
from datetime import datetime, timezone
path = Path.home() / 'license-server/Caddyfile'
old = path.read_text()
proxy = ('\treverse_proxy 192.168.1.2:18871 {\n\t\tflush_interval -1\n'
         '\t\t# サーバーの入れ替え中（数秒）は 502 を返さず、つながるまで待って渡す（2026-10-10 ナユタ）。\n'
         '\t\t# 接続できない間だけ待つ。上流へ届いた後に失敗した要求は、GETだけ送り直す（Caddyの既定）。\n'
         '\t\tlb_try_duration 20s\n\t\tlb_try_interval 250ms\n\t}\n')
host = 'approval-box.kitepon.dev {\n'
start = old.find(host)
if start < 0 or old.count(host) != 1 or old.find(proxy, start) < 0:
    raise SystemExit('Approval Box virtual host or its reverse_proxy is not uniquely identifiable.')
if '@approvalbox_tunnel' in old:
    raise SystemExit('Already applied.')
tunnel = ('\t# 呼び手の数え方（2026-11-23 ナユタ、ログイン部品の監査 1.34）: トンネル（cloudflared）から来た要求は、\n'
          '\t# Cloudflare の CF-Connecting-IP を X-Forwarded-For にして渡す。サーバーはその最後の値で接続元ごとの回数を数える。\n'
          '\t@approvalbox_tunnel remote_ip 172.18.0.0/16\n'
          + proxy.replace('reverse_proxy 192.168.1.2:18871 {', 'reverse_proxy @approvalbox_tunnel 192.168.1.2:18871 {', 1)
                 .replace('\t\tlb_try_interval 250ms\n\t}\n', '\t\tlb_try_interval 250ms\n\t\theader_up X-Forwarded-For {http.request.header.Cf-Connecting-Ip}\n\t}\n', 1))
i = old.find(proxy, start)
new = old[:i] + tunnel + old[i:]
backup = path.with_name('Caddyfile.bak-approvalbox-caller-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
shutil.copy2(path, backup)
path.write_text(new)
cmd = lambda verb: subprocess.run(['docker', 'exec', 'caddy', 'caddy', verb, '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    cmd('validate'); cmd('reload')
except subprocess.CalledProcessError as e:
    path.write_text(old)
    subprocess.run(['docker', 'exec', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    raise SystemExit('Caddy validation/reload failed; restored previous configuration: ' + e.stderr.decode()[-400:])
print('applied; backup ' + backup.name)
