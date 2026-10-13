#!/bin/sh
# コンテナの入口。SECRETS_DIR を指定した時だけ働く。
# 環境変数で受け取った鍵を SECRETS_DIR（tmpfs）の 600 のファイルへ移し、*_FILE をそこへ向け、
# 値の環境変数を外してからサーバーを起こす。指定が無ければ、何もせずにサーバーを起こす。
# 起こし直しのたびに作り直すので、鍵の保管庫へつながらなくても起きる。
set -eu

# put <変数の名前> <ファイルの名前> [pem]
# 値が空なら何もしない。保管庫は末尾の改行を外して持つので、書く時に1つ足す。
put() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || return 0
  file="$SECRETS_DIR/$2"
  # pem は「改行を \n と書いた1行」も受ける（APNS_KEY の今までの書き方）。
  if [ "${3:-}" = pem ]; then
    printf '%s\n' "$value" | sed 's/\\n/\
/g' > "$file" || fail "$1" "$file"
  else
    printf '%s\n' "$value" > "$file" || fail "$1" "$file"
  fi
  chmod 600 "$file" || fail "$1" "$file"
  export "$1_FILE=$file"
  unset "$1" value
}

# 値は出さない。名前と置き場だけを出して止まる。
fail() {
  echo "approval-box-server: $1 を $2 へ書けません。起動をやめます。" >&2
  exit 1
}

if [ -n "${SECRETS_DIR:-}" ]; then
  if [ ! -d "$SECRETS_DIR" ] || [ ! -w "$SECRETS_DIR" ]; then
    echo "approval-box-server: SECRETS_DIR（$SECRETS_DIR）へ書けません。起動をやめます。" >&2
    exit 1
  fi
  umask 077
  put APNS_KEY apns-AuthKey.p8 pem
  put DIAGNOSTICS_ADMIN_KEY diagnostics-admin.key
  put CALL_BRIDGE_HEADERS call-bridge.header
fi
exec "$@"
