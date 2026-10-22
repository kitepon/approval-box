#!/bin/sh
# Verify before extracting. All inputs are public; never use a user's GPG keyring.
set -eu
archive=${1:?archive path}
node_arch=${2:?Node archive architecture}
assets=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
chmod 700 "$work"
gpgv --homedir "$work" --keyring "$assets/nodejs-release-keyring.kbx" \
  --status-fd 3 --output "$work/sums" "$assets/SHASUMS256.txt.asc" 3>"$work/status"
# Pin the release signer as well as the keyring, not merely any key in it.
awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" && $3 == "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356" { ok=1 } END { exit !ok }' "$work/status"
name="node-v24.22.1-linux-$node_arch.tar.xz"
expected=$(awk -v name="$name" '$2 == name { print $1; n++ } END { if (n != 1) exit 1 }' "$work/sums")
actual=$(sha256sum "$archive")
actual=${actual%% *}
test "$expected" = "$actual"
printf '%s  %s\n' "$actual" "$name"
