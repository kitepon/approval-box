#!/usr/bin/env python3
"""Read/update a sanitized diagnostic group on main-server without printing keys.
Usage: python3 - <event UUID> inspect|resolve|reopen
"""
import json
from pathlib import Path
import sys
import urllib.request
import uuid

event_id = str(uuid.UUID(sys.argv[1]))
action = sys.argv[2] if len(sys.argv) > 2 else 'inspect'
if action not in ('inspect', 'resolve', 'reopen'):
    raise SystemExit('Unknown action')
key = (Path.home()/'.config/approval-box/bughub.env').read_text().strip().split('=',1)[1]
base = 'http://192.168.1.2:18871/api/admin/logs'
headers = {'Authorization':'Bearer '+key,'Content-Type':'application/json'}
with urllib.request.urlopen(urllib.request.Request(base+'?status=all&limit=500',headers=headers),timeout=10) as response:
    rows = json.load(response)
row = next((r for r in rows if r.get('diagnostic_context',{}).get('event_id','').lower()==event_id), None)
if row is None:
    raise SystemExit('Event is not the latest event in any group.')
if action != 'inspect':
    body = {'fingerprint':row['fingerprint']}
    if action == 'resolve': body['note']='Diagnostic integration smoke completed.'
    request = urllib.request.Request(base+'/'+action,data=json.dumps(body).encode(),headers=headers,method='POST')
    with urllib.request.urlopen(request,timeout=10) as response:
        print('mutation',response.status,json.dumps(json.load(response)))
    with urllib.request.urlopen(urllib.request.Request(base+'?status=all&limit=500',headers=headers),timeout=10) as response:
        row = next(r for r in json.load(response) if r['fingerprint'] == row['fingerprint'])
# These fields are allowlisted metadata, no user/session/admin key.
print(json.dumps({name:row.get(name) for name in ('fingerprint','severity','message_template','occurrence_count','last_seen','status','module','category','app_version','diagnostic_log','diagnostic_context')},ensure_ascii=False))
