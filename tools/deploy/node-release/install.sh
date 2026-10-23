#!/bin/sh
set -eu
# BUILDPLATFORM downloads/verifies, TARGETARCH selects the glibc release.
case "${1:?Docker target architecture}" in
  amd64) node_arch=x64 ;;
  arm64) node_arch=arm64 ;;
  ppc64le) node_arch=ppc64le ;;
  s390x) node_arch=s390x ;;
  *) echo "Unsupported Node glibc architecture: $1" >&2; exit 1 ;;
esac
assets=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
archive="$work/node.tar.xz"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-$node_arch.tar.xz" -o "$archive"
sh "$assets/verify.sh" "$archive" "$node_arch"
mkdir -p /verified-node
tar -xJf "$archive" -C /verified-node --strip-components=1 --no-same-owner
