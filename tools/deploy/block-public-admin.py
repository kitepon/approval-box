#!/usr/bin/env python3
"""Add Approval Box's public admin-path block only; validate/reload Caddy.
Run on main-server; the repository owns this reproducible deployment change.
"""
from pathlib import Path
import subprocess
import shutil
from datetime import datetime, timezone
path = Path.home() / 'license-server/Caddyfile'
old = path.read_text()
marker = 'approval-box.kitepon.dev {\n'
block = '\t@approvalbox_admin path /api/admin /api/admin/*\n\trespond @approvalbox_admin 404\n'
if marker not in old or old.count(marker) != 1:
    raise SystemExit('Approval Box virtual host is not uniquely identifiable.')
if block not in old:
    backup = path.with_name('Caddyfile.bak-approvalbox-diagnostics-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(path, backup)
    path.write_text(old.replace(marker, marker + block, 1))
    try:
        subprocess.run(['docker','exec','caddy','caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        subprocess.run(['docker','exec','caddy','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    except subprocess.CalledProcessError:
        path.write_text(old)
        subprocess.run(['docker','exec','caddy','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        raise SystemExit('Caddy validation/reload failed; restored previous configuration.')
print('Public admin path blocked; other virtual hosts unchanged.')
