#!/usr/bin/env bash
set -euo pipefail
directory=${1:?pass an empty private directory}
mkdir -p "$directory"
test -z "$(ls -A "$directory")"
chmod 700 "$directory"
umask 077
openssl rand -hex 32 > "$directory/api-token"
openssl rand -hex 32 > "$directory/s3-secret-access-key"
chmod 444 "$directory/api-token" "$directory/s3-secret-access-key"
