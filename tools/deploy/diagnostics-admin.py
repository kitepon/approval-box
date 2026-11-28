#!/usr/bin/env python3
"""Read/update a sanitized diagnostic group without printing keys.
Two ways to authenticate, never printing the key:
  - BellTeam's auth module (the operator's setup, Sakura 2026-11-28): run from the granted unit (/home/kite on main-server)
      python3 diagnostics-admin.py <event UUID> inspect|resolve|reopen
    The module adds the admin key itself (item "http bughub-approvalbox-admin", Sakura 2026-11-28); this script never sees it.
  - Without the module (self-hosters): put APPROVALBOX_ADMIN_KEY in the environment.
The target is the official operator's LAN endpoint; see docs/diagnostics.md.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

event_id = str(uuid.UUID(sys.argv[1]))
action = sys.argv[2] if len(sys.argv) > 2 else 'inspect'
if action not in ('inspect', 'resolve', 'reopen'):
    raise SystemExit('Unknown action')
key = os.environ.get('APPROVALBOX_ADMIN_KEY', '').strip()
auth = os.environ.get('AUTH_BIN') or shutil.which('auth') or os.path.expanduser('~/.local/bin/auth')
item = os.environ.get('APPROVALBOX_ADMIN_ITEM', 'bughub-approvalbox-admin')
base_url = 'http://192.168.1.2:18871'
path = '/api/admin/logs'


def call(method, suffix, body=None):
    data = json.dumps(body).encode() if body is not None else None
    if key:
        request = urllib.request.Request(base_url + path + suffix, data=data, method=method,
                                         headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    if not os.path.exists(auth):
        raise SystemExit('Neither the auth module client nor APPROVALBOX_ADMIN_KEY is available (see the usage above).')
    args = [auth, 'http', item, method, path + suffix, '-H', 'Content-Type: application/json']
    if data is not None:
        args += ['--data-file', '-']
    done = subprocess.run(args, input=data, capture_output=True, timeout=30)
    status = next((line.split()[1] for line in done.stderr.decode(errors='replace').splitlines() if line.startswith('HTTP ')), '')
    if done.returncode not in (0, 22):
        raise SystemExit('The auth module refused or failed (exit %d).' % done.returncode)
    if done.returncode == 22:
        raise SystemExit('The admin API answered HTTP %s.' % status)
    return int(status or 200), json.loads(done.stdout)


_, rows = call('GET', '?status=all&limit=500')
row = next((r for r in rows if r.get('diagnostic_context', {}).get('event_id', '').lower() == event_id), None)
if row is None:
    raise SystemExit('Event is not the latest event in any group.')
if action != 'inspect':
    body = {'fingerprint': row['fingerprint']}
    if action == 'resolve': body['note'] = 'Diagnostic integration smoke completed.'
    status, answer = call('POST', '/' + action, body)
    print('mutation', status, json.dumps(answer))
    _, rows = call('GET', '?status=all&limit=500')
    row = next(r for r in rows if r['fingerprint'] == row['fingerprint'])
# These fields are allowlisted metadata, no user/session/admin key.
print(json.dumps({name: row.get(name) for name in ('fingerprint', 'severity', 'message_template', 'occurrence_count', 'last_seen', 'status', 'module', 'category', 'app_version', 'diagnostic_log', 'diagnostic_context')}, ensure_ascii=False))
