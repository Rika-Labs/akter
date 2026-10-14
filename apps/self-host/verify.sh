#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
runtime=${SELFHOST_RUNTIME:-bun}
export SELFHOST_RUNTIME=$runtime
secrets=$(mktemp -d)
export SELFHOST_SECRETS_DIR=$secrets/credentials
compose=(docker compose -f apps/self-host/compose.yml)
image=akter-selfhost-$runtime:local

if docker ps -a --format '{{.Names}}' | grep -q '^akter-selfhost-'; then
  echo "akter-selfhost-* containers already exist; refusing to touch them" >&2
  exit 1
fi

cleanup() {
  docker rm -f akter-selfhost-fs >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$secrets"
}
trap cleanup EXIT

bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"
token=$(cat "$SELFHOST_SECRETS_DIR/api-token")

command_id() {
  local now
  now=$(($(date +%s) * 1000))
  echo "v1.$now.$((now + 600000)).$(uuidgen | tr '[:upper:]' '[:lower:]')"
}

call() {
  local port=$1 id=$2 amount=$3 authorization=${4-Bearer $token}
  printf '{"_tag":"Request","id":"1","tag":"Counter/add","payload":{"id":"visits","commandId":"%s","payload":%s},"headers":[]}\n' "$id" "$amount" |
    curl --silent --show-error --max-time 10 -X POST "http://127.0.0.1:$port/rpc" \
      -H "authorization: $authorization" -H 'content-type: application/ndjson' --data-binary @-
}

expect() {
  case "$2" in
    *"$1"*) ;;
    *) echo "expected $1, got $2" >&2; exit 1 ;;
  esac
}

ready() {
  for _ in $(seq 1 60); do
    if curl --silent --fail "http://127.0.0.1:$1/ready" >/dev/null; then return 0; fi
    sleep 1
  done
  echo "port $1 never became ready" >&2
  exit 1
}

"${compose[@]}" build runner
"${compose[@]}" up -d --wait runner
ready 18080

first=$(command_id)
expect '"value":3,"replayed":false' "$(call 18080 "$first" 3)"
expect '"value":3,"replayed":true' "$(call 18080 "$first" 3)"
expect '"code":"invalid_credentials"' "$(call 18080 "$(command_id)" 1 'Bearer wrong')"
expect '"code":"missing_credentials"' "$(call 18080 "$(command_id)" 1 '')"

"${compose[@]}" restart runner
ready 18080
expect '"value":3,"replayed":true' "$(call 18080 "$first" 3)"
expect '"value":10,"replayed":false' "$(call 18080 "$(command_id)" 7)"
echo "S3_OK MinIO store: replayed retry, refused credentials, state and outcome survive a restart"

docker run -d --name akter-selfhost-fs -p 127.0.0.1:18079:8080 \
  -v "$SELFHOST_SECRETS_DIR/api-token:/run/secrets/api-token:ro" "$image" >/dev/null
ready 18079
filed=$(command_id)
expect '"value":5,"replayed":false' "$(call 18079 "$filed" 5)"
docker restart akter-selfhost-fs >/dev/null
ready 18079
expect '"value":5,"replayed":true' "$(call 18079 "$filed" 5)"
expect '"value":6,"replayed":false' "$(call 18079 "$(command_id)" 1)"
echo "FS_OK file-system store: state and outcome survive a restart"
echo "SELFHOST_OK $runtime"
