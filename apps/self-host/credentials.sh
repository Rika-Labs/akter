#!/usr/bin/env bash
set -euo pipefail
directory=${1:?pass an empty private directory}
mkdir -p "$directory"
test -z "$(ls -A "$directory")"
chmod 700 "$directory"
umask 077
openssl rand -hex 32 > "$directory/database-password"
openssl rand -hex 32 > "$directory/api-token"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$directory/ca-key.pem" -out "$directory/ca.pem" -subj /CN=akter-selfhost-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
for runner in runner-a runner-b; do
  openssl req -new -newkey rsa:2048 -nodes -keyout "$directory/$runner-key.pem" \
    -out "$directory/$runner.csr" -subj "/CN=$runner"
  printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth,clientAuth' \
    'subjectAltName=URI:spiffe://akter/deployment/self-host' > "$directory/$runner.ext"
  openssl x509 -req -in "$directory/$runner.csr" -CA "$directory/ca.pem" \
    -CAkey "$directory/ca-key.pem" -CAcreateserial -days 7 \
    -extfile "$directory/$runner.ext" -out "$directory/$runner.pem"
done
chmod 644 "$directory/ca.pem" "$directory/runner-a.pem" "$directory/runner-b.pem"
chmod 600 "$directory/ca-key.pem"
chmod 444 "$directory/runner-a-key.pem" "$directory/runner-b-key.pem" "$directory/database-password" "$directory/api-token"
