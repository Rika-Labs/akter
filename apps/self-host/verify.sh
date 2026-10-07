#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
runtime=${SELFHOST_RUNTIME:-bun}
case "$runtime" in bun|node) ;; *) echo 'SELFHOST_RUNTIME must be bun or node' >&2; exit 1 ;; esac
for container in akter-selfhost-pg akter-selfhost-runner-a akter-selfhost-runner-b akter-selfhost-client; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "$container already exists; refusing to touch an existing deployment" >&2
    exit 1
  fi
done
if docker volume inspect akter-selfhost_data >/dev/null 2>&1; then
  echo 'akter-selfhost_data already exists; refusing to touch an existing deployment' >&2
  exit 1
fi
mkdir -p .local
work=$(mktemp -d "$PWD/.local/self-host-verify-XXXXXX")
export SELFHOST_SECRETS_DIR="$work/secrets"
export COMMAND_DELAY_MS=3000
compose() { docker compose --project-name akter-selfhost -f apps/self-host/compose.yml "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color; fi
  if docker container inspect akter-selfhost-client >/dev/null 2>&1; then
    if [ "$status" -ne 0 ]; then docker logs akter-selfhost-client; fi
    docker rm -f akter-selfhost-client
  fi
  compose down --volumes
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"
compose build runner-a
compose up -d --wait postgres
sql() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U project -d project -Atc "$1"; }
test "$(sql "SELECT count(*) FROM pg_tables WHERE tablename = 'actor_migrations'")" = 0
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U project -d project <<'SQL'
CREATE TABLE self_host_ddl (identity text NOT NULL);
CREATE FUNCTION self_host_ddl_audit() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE command record;
BEGIN
  FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF command.object_identity = 'public.actor_migrations' AND command.command_tag = 'CREATE TABLE' THEN
      INSERT INTO self_host_ddl VALUES (command.object_identity);
      PERFORM pg_sleep(8);
    END IF;
  END LOOP;
END $$;
CREATE EVENT TRIGGER self_host_ddl ON ddl_command_end EXECUTE FUNCTION self_host_ddl_audit();
SQL
compose up -d runner-a runner-b
not_ready=0
migration_blocked=0
for attempt in $(seq 1 120); do
  if ! first=$(curl --max-time 2 -s -o "$work/ready-a" -w '%{http_code}' http://127.0.0.1:18081/ready); then first=000; fi
  if ! second=$(curl --max-time 2 -s -o "$work/ready-b" -w '%{http_code}' http://127.0.0.1:18082/ready); then second=000; fi
  if [ "$(sql "SELECT count(*) FROM pg_stat_activity WHERE datname = 'project' AND wait_event = 'PgSleep'")" -gt 0 ]; then
    test "$first" != 200
    test "$second" != 200
    migration_blocked=$((migration_blocked + 1))
  fi
  if [ "$first" = 200 ] && [ "$second" = 200 ]; then break; fi
  not_ready=$((not_ready + 1))
  sleep 1
done
test "$not_ready" -gt 0
test "$migration_blocked" -gt 0
test "$first" = 200
test "$second" = 200
test "$(sql 'SELECT count(*) FROM self_host_ddl')" = 1
test "$(sql 'SELECT count(*) FROM cluster_runners WHERE healthy')" = 2
test "$(sql "SELECT count(*) FROM actor_placements WHERE actor_type = 'Counter'")" = 1
sql 'SELECT migration_id, name, created_at FROM actor_migrations ORDER BY migration_id' > "$work/history-before"
test -s "$work/history-before"
curl -fsS http://127.0.0.1:18081/health
curl -fsS http://127.0.0.1:18082/health
compose exec -T runner-a "$runtime" --version
compose exec -T runner-a "$runtime" apps/self-host/src/check.ts
compose exec -T runner-a "$runtime" apps/self-host/src/peers.ts
owner=$(compose logs --no-color runner-a runner-b | grep 'COMMAND_STARTED' | tail -1 | cut -d ' ' -f1)
case "$owner" in
  akter-selfhost-runner-a) owner=runner-a ;;
  akter-selfhost-runner-b) owner=runner-b ;;
  *) echo "Cannot identify counter owner from handler logs" >&2; exit 1 ;;
esac

compose run --no-deps -d --name akter-selfhost-client -e CHECK_MODE=hold -e "CHECK_HOST=$owner" \
  --entrypoint "$runtime" runner-a apps/self-host/src/check.ts
for attempt in $(seq 1 30); do
  if docker exec akter-selfhost-client test -s /tmp/self-host-command-id; then break; fi
  sleep 1
done
docker cp akter-selfhost-client:/tmp/self-host-command-id "$work/command-id"
id=$(cat "$work/command-id")
for attempt in $(seq 1 30); do
  if compose logs --no-color runner-a runner-b | grep -F "COMMAND_STARTED $id" >/dev/null; then break; fi
  sleep 0.1
done
compose logs --no-color runner-a runner-b | grep -F "COMMAND_STARTED $id"
test "$(sql "SELECT count(*) FROM actor_receipts WHERE command_id = '$id'")" = 0
compose stop runner-a runner-b
test "$(docker wait akter-selfhost-client)" = 0
docker logs akter-selfhost-client | grep -F 'HOLD_OK in-flight command committed 21'
docker logs akter-selfhost-client | grep -F 'UNREADY_OK active runner reported draining before command completed'
test "$(sql "SELECT count(*) FROM actor_receipts WHERE command_id = '$id'")" = 1
compose logs --no-color runner-a runner-b | grep -F 'DRAINED {"outcome":"clean","interruptedTurns":0,"interruptedJobs":0}' > "$work/drain"
test "$(wc -l < "$work/drain" | tr -d ' ')" = 2
for runner in runner-a runner-b; do
  test "$(docker inspect -f '{{.State.ExitCode}}' "akter-selfhost-$runner")" = 0
done
compose up -d --wait runner-a runner-b
compose exec -T -e CHECK_MODE=replay -e "CHECK_COMMAND_ID=$id" runner-b "$runtime" apps/self-host/src/check.ts
sql 'SELECT migration_id, name, created_at FROM actor_migrations ORDER BY migration_id' > "$work/history-after"
cmp "$work/history-before" "$work/history-after"
test "$(sql 'SELECT count(*) FROM self_host_ddl')" = 1
docker rm akter-selfhost-client
compose run --no-deps -d --name akter-selfhost-client -e CHECK_MODE=stack -e "CHECK_HOST=$owner" \
  --entrypoint "$runtime" runner-a apps/self-host/src/check.ts
for attempt in $(seq 1 30); do
  if docker exec akter-selfhost-client test -s /tmp/self-host-command-id; then break; fi
  sleep 1
done
docker cp akter-selfhost-client:/tmp/self-host-command-id "$work/stack-command-id"
id=$(cat "$work/stack-command-id")
for attempt in $(seq 1 30); do
  if compose logs --no-color runner-a runner-b | grep -F "COMMAND_STARTED $id" >/dev/null; then break; fi
  sleep 0.1
done
compose logs --no-color runner-a runner-b | grep -F "COMMAND_STARTED $id"
test "$(sql "SELECT count(*) FROM actor_receipts WHERE command_id = '$id'")" = 0
compose stop
compose up -d --wait
test "$(docker wait akter-selfhost-client)" = 0
docker logs akter-selfhost-client | grep -F 'STACK_OK command survived full Compose stop and restart, count 34'
test "$(sql "SELECT count(*) FROM actor_receipts WHERE command_id = '$id'")" = 1
compose exec -T -e CHECK_MODE=stack-replay -e "CHECK_COMMAND_ID=$id" runner-b "$runtime" apps/self-host/src/check.ts
compose stop
echo "SELFHOST_OK $runtime: concurrent migrations, readiness, two-runner client calls, mTLS, SIGTERM drain and receipt replay"
