#!/usr/bin/env bash
set -u
case "$VERIFY_RUNS" in
  '' | *[!0-9]* | ????*)
    echo "runs must be an integer from 1 to 25" >&2
    exit 2
    ;;
esac
if [ "$VERIFY_RUNS" -lt 1 ] || [ "$VERIFY_RUNS" -gt 25 ]; then
  echo "runs must be an integer from 1 to 25" >&2
  exit 2
fi
mkdir -p stress
burners=()
for _ in $(seq "$(getconf _NPROCESSORS_ONLN)"); do
  (while :; do :; done) &
  burners+=($!)
done
trap 'kill "${burners[@]}" 2>/dev/null || true' EXIT
failed=0
for run in $(seq "$VERIFY_RUNS"); do
  while read -r suite script projects; do
    name="$suite-$run"
    status=0
    (cd packages/akter && bun run "$script" $projects --reporter=default --reporter=json --outputFile.json="stress/$name.json") \
      > "stress/$name.log" 2>&1 || status=$?
    echo "$status" > "stress/$name.status"
    echo "run $run $suite exited $status"
    if [ "$status" -ne 0 ]; then failed=1; fi
  done <<'SUITES'
test test
test-integration-postgres test:integration:postgres --project=!integration:migrations
test-integration-migrations test:integration:postgres --project=integration:migrations
test-integration-drills test:integration:drills
SUITES
done
STRESS_DIR=stress STRESS_RUNS="$VERIFY_RUNS" \
  STRESS_SUITES="test test-integration-postgres test-integration-migrations test-integration-drills" \
  bun .github/src/stress-summary.ts
exit "$failed"
