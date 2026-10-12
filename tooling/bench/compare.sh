#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
harness=$(cd "$(dirname "$0")" && pwd)
base=$(git -C "$root" rev-parse --verify --end-of-options "${1:?Pass a base ref}^{commit}")
head=$(git -C "$root" rev-parse --verify --end-of-options "${2:?Pass a head ref}^{commit}")
rounds=${BENCH_ROUNDS:-3}
[[ "$rounds" =~ ^[0-9]+$ ]] && [ "$rounds" -ge 3 ] || { echo 'BENCH_ROUNDS must be at least 3' >&2; exit 2; }
output=${BENCH_OUTPUT:-$HOME/.capy/work/akter-bench/$(date +%Y%m%d-%H%M%S)-$$}
[[ "$output" = /* ]] || { echo 'BENCH_OUTPUT must be absolute' >&2; exit 2; }
[ ! -e "$output" ] || { echo "Refusing to reuse evidence directory: $output" >&2; exit 2; }
mkdir -p "$output"
prefix="akter-bench-$(date +%s)-$$"
network="$prefix"
relay="$prefix-relay"
postgres="$prefix-postgres"
runner="$prefix-runner"
client="$prefix-client"
volume="$prefix-postgres-data"
cleanup() {
  docker rm -fv "$client" "$runner" "$postgres" "$relay" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm "$prefix-base" "$prefix-head" "$prefix-relay" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
for side in base head; do
  sha=$base
  [ "$side" = head ] && sha=$head
  mkdir -p "$output/build/$side/source" "$output/build/$side/harness"
  git -C "$root" archive "$sha" | tar -x -C "$output/build/$side/source"
  cp "$harness"/src/*.ts "$output/build/$side/harness/"
  docker build -f "$harness/Dockerfile" -t "$prefix-$side" "$output/build/$side" >"$output/build-$side.log" 2>&1
  docker run --rm "$prefix-$side" getconf CLK_TCK >"$output/$side.clock-ticks.txt"
done
docker build -f "$harness/relay.Dockerfile" -t "$prefix-relay" "$harness" >"$output/build-relay.log" 2>&1
docker network create "$network" >/dev/null
docker run -d --name "$relay" --network "$network" --network-alias relay --cap-add NET_ADMIN \
  --cpuset-cpus 2 --cpus 1 "$prefix-relay" >/dev/null
docker exec "$relay" tc qdisc add dev eth0 root netem delay 1250us
docker info >"$output/docker-info.txt"
docker image inspect "$prefix-base" "$prefix-head" "$prefix-relay" >"$output/images.json"
(cd "$harness" && find src -name '*.ts' | LC_ALL=C sort | xargs shasum -a 256) >"$output/harness.sha256"
bun -e 'console.log(JSON.stringify({base:process.argv[1],head:process.argv[2],host:require("node:os").hostname(),platform:process.platform,arch:process.arch,bun:Bun.version,rounds:Number(process.argv[3]),githubRun:process.env.GITHUB_RUN_ID??null,reference:process.env.GITHUB_ACTIONS==="true",rttMs:2.5,runnerCpus:1,postgresCpus:1,maxConnections:100},null,2))' "$base" "$head" "$rounds" >"$output/host.json"
cases=${BENCH_CASES:-$(bun -e "import {scenarios} from '$harness/src/scenarios.ts'; console.log(scenarios.map(x=>x.name).join(','))")}
IFS=',' read -r -a cohorts <<<"$cases"
printf '[\n' >"$output/order.json"
first=true
run_case() {
  local side=$1 round=$2 cohort=$3 diagnostic=$4 sha label operation
  local flags=(--no-install)
  sha=$base
  [ "$side" = head ] && sha=$head
  label="$side-r$round-$cohort"
  [ "$diagnostic" = 1 ] && label="diag-$side-$cohort"
  if [ "$diagnostic" = 1 ] && [[ ",${BENCH_PROFILE_CASES:-}," = *",$cohort,"* ]]; then
    flags+=(--cpu-prof --cpu-prof-dir=/results "--cpu-prof-name=$label.cpuprofile"
      --heap-prof --heap-prof-dir=/results "--heap-prof-name=$label.heapprofile")
  fi
  operation=$(CASE="$cohort" bun -e "import {scenarios} from '$harness/src/scenarios.ts'; const x=scenarios.find(x=>x.name===Bun.env.CASE); if(!x)throw Error('Unknown case');console.log(x.operation)")
  docker volume create --label "akter.bench=$prefix" "$volume" >/dev/null
  docker run -d --name "$postgres" --network "$network" --network-alias postgres --cpuset-cpus 1 --cpus 1 \
    --mount "type=volume,source=$volume,target=/var/lib/postgresql" \
    -e POSTGRES_USER=project -e POSTGRES_PASSWORD=project -e POSTGRES_DB=project \
    postgres:18.6-bookworm -c shared_preload_libraries=pg_stat_statements -c synchronous_commit=on -c max_connections=100 >/dev/null
  ready=false
  for attempt in $(seq 1 120); do
    if docker exec "$postgres" pg_isready -h 127.0.0.1 -U project -d project >/dev/null 2>&1; then ready=true; break; fi
    sleep 0.25
  done
  [ "$ready" = true ] || { docker logs "$postgres" >&2; exit 1; }
  docker exec "$postgres" psql -h 127.0.0.1 -U project -d project -Atc "SELECT version(); SHOW synchronous_commit; SHOW max_connections;" >"$output/$label.postgres.txt"
  docker inspect "$postgres" --format '{{json .Mounts}}' >"$output/$label.mounts.json"
  docker run -d --name "$runner" --network "$network" --network-alias runner --cpuset-cpus 0 --cpus 1 --memory 3g \
    -e DATABASE_URL=postgres://project:project@relay:5432/project -e "OPERATION=$operation" -e "DIAGNOSTIC=$diagnostic" \
    -v "$output:/results" "$prefix-$side" bun "${flags[@]}" tooling/bench/src/server.ts >/dev/null
  if ! docker run --rm --name "$client" --network "$network" --cpuset-cpus 3 --cpus 1 \
    -e SERVER_URL=http://runner:8080 -e DIRECT_DATABASE_URL=postgres://project:project@postgres:5432/project \
    -e "CASE=$cohort" -e "SECONDS=${BENCH_SECONDS:-20}" -e "WARMUP_SECONDS=${BENCH_WARMUP_SECONDS:-3}" \
    -e "SHA=$sha" -e "DIAGNOSTIC=$diagnostic" -e "WAKE_REPEATS=${BENCH_WAKE_REPEATS:-5}" \
    -e "OUTPUT=/results/$label.json" -v "$output:/results" "$prefix-$side" bun --no-install tooling/bench/src/drive.ts \
    >"$output/$label.driver.log" 2>&1; then
    docker logs "$runner" >"$output/$label.server.log" 2>&1
    cat "$output/$label.driver.log" "$output/$label.server.log" >&2
    exit 1
  fi
  docker wait "$runner" >"$output/$label.exit.txt"
  [ "$(cat "$output/$label.exit.txt")" = 0 ] || { docker logs "$runner" >&2; exit 1; }
  docker logs "$runner" >"$output/$label.server.log" 2>&1
  docker rm -fv "$runner" "$postgres" >/dev/null
  docker volume rm "$volume" >/dev/null
  [ "$first" = true ] || printf ',\n' >>"$output/order.json"
  first=false
  printf '  "%s.json"' "$label" >>"$output/order.json"
  echo "$label complete"
}
for round in $(seq 1 "$rounds"); do
  sides=(base head)
  [ $((round % 2)) = 0 ] && sides=(head base)
  for cohort in "${cohorts[@]}"; do
    for side in "${sides[@]}"; do run_case "$side" "$round" "$cohort" 0; done
  done
done
if [ "${BENCH_DIAGNOSTICS:-1}" = 1 ]; then
  for cohort in sequential-write hot-write spread-write; do
    for side in base head; do run_case "$side" 0 "$cohort" 1; done
  done
fi
printf '\n]\n' >>"$output/order.json"
bun "$harness/src/report.ts" "$output" "$base" "$head"
echo "Evidence: $output"
