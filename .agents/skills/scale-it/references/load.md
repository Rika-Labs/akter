# Load tools

## Journeys with k6

Use your actual isolated server origin as `BASE_URL` and script the real caller protocol. There is no
seeded cookie login in this repo. `/rpc` HTTP POST uses NDJSON; JSON WebSocket and Effect client flows
need a protocol-correct harness, not a guessed REST request. A readiness GET measures readiness only,
not actor throughput. Never put credentials in argv or saved evidence. Ramp until a threshold aborts:

```js
export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 1000,
      stages: [
        { target: 50, duration: "30s" },
        { target: 200, duration: "30s" },
        { target: 800, duration: "30s" },
      ],
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: true }],
    http_req_duration: [{ threshold: "p(99)<1000", abortOnFail: true }],
  },
}
```

```bash
k6 run --no-usage-report -e BASE_URL="$ORIGIN" --summary-trend-stats 'med,p(90),p(99),max' \
  --summary-export "$EVIDENCE/k6-summary.json" "$HARNESS"
```

Set `ORIGIN` from the actual server, `EVIDENCE` to an absolute directory outside the repo and `HARNESS`
to your journey script; these are placeholders, not checked-in files. Run load suites through the
machine's workload gate when required.

- k6 calls p50 `med`.
- A whole-run p99 can abort on early noise. Judge each stage on its own window, or run one fixed rate per
  stage. Maximum load sustained is the highest stage whose own p99 and errors held.

## One endpoint with oha

Connections, not users. Raise `-c` until p99 or errors break the bar:

```bash
for c in 10 50 200; do oha -z 20s -c "$c" --no-tui --output-format json \
  "$TARGET_URL" > "$EVIDENCE/oha-$c.json"; done
```

Set `TARGET_URL` to the actual unauthenticated endpoint being measured. This example is not an
authenticated RPC write harness; use the public Effect client for that claim.

- Use `127.0.0.1`; `localhost` may resolve to IPv6 and be refused.
- Trust no rps until `statusCodeDistribution` is non-empty; count `errorDistribution`. A fast 429 or 500 is
  not a fast answer.
- Writes: `-m POST -d '<body>' -T application/json`. Fixed rate: `-q <qps>`.
- Repeat each run at least 3 times and compare against a baseline run.
