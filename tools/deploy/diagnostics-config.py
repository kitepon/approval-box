#!/usr/bin/env python3
"""Run on the production host as its service owner; never prints secrets.
Derived runtime files stay outside the public repository. Existing keys are reused.
"""
from pathlib import Path
import os
import secrets

home = Path.home()
root = home / 'approval-box/deploy'
secret = root / 'secrets/bughub-admin.key'
secret.parent.mkdir(parents=True, exist_ok=True)
if not secret.exists():
    fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(secrets.token_hex(32) + '\n')
os.chmod(secret, 0o600)
key = secret.read_text().strip()
if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
    raise SystemExit('Invalid existing admin key; not overwriting it.')
shared = home / '.config/approval-box/bughub.env'
shared.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(shared, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write('APPROVALBOX_ADMIN_KEY=' + key + '\n')
os.chmod(shared, 0o600)
env_file = root / '.env'
lines = env_file.read_text().splitlines()
lines = [line for line in lines if not line.startswith(('DIAGNOSTICS_ADMIN_KEY=', 'DIAGNOSTICS_ADMIN_KEY_FILE='))]
lines.append('DIAGNOSTICS_ADMIN_KEY_FILE=/run/secrets/bughub-admin.key')
env_file.write_text('\n'.join(lines) + '\n')
os.chmod(env_file, 0o600)
# Production already mounts deploy/secrets at /run/secrets read-only.
if '/run/secrets:ro' not in (root / 'compose.override.yaml').read_text():
    raise SystemExit('Missing read-only secret volume; install before deployment.')
print('Admin key installed; BugHub handoff file mode=600. No secret printed.')
