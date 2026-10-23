#!/bin/sh
# A forged checksum manifest must fail even when it matches the forged archive.
set -eu
archive=${1:?path to the downloaded official linux-x64 tar.xz}
assets=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$assets/verify.sh" "$archive" x64
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cp "$assets/verify.sh" "$assets/nodejs-release-keyring.kbx" "$assets/SHASUMS256.txt.asc" "$work/"
printf 'untrusted archive\n' > "$work/forged.tar.xz"
if sh "$assets/verify.sh" "$work/forged.tar.xz" x64 > "$work/checksum.log" 2>&1; then
  echo 'accepted archive with incorrect checksum' >&2; exit 1
fi
forged=$(sha256sum "$work/forged.tar.xz")
forged=${forged%% *}
sed "s/^6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 /$forged /" "$assets/SHASUMS256.txt.asc" > "$work/SHASUMS256.txt.asc"
if sh "$work/verify.sh" "$work/forged.tar.xz" x64 > "$work/signature.log" 2>&1; then
  echo 'accepted modified manifest with invalid signature' >&2; exit 1
fi
printf 'valid release accepted; incorrect archive and forged signed manifest rejected\n'
