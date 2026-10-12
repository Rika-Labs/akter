import { randomUUID } from "node:crypto"
import { SQL } from "bun"
import { Schema } from "effect"
import { percentile, type Result } from "./results.ts"
import { keySequence, scenarios } from "./scenarios.ts"

const Snapshot = Schema.Struct({
  at: Schema.Finite,
  wall: Schema.Finite,
  cpu: Schema.Struct({ user: Schema.Finite, system: Schema.Finite }),
  mainTicks: Schema.Finite,
  rss: Schema.Finite,
  resident: Schema.Finite,
  flights: Schema.Finite,
  statements: Schema.Finite,
  bun: Schema.String,
})
const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Int))
const scenario = scenarios.find((entry) => entry.name === process.env.CASE)
if (scenario === undefined) throw new Error("Set CASE to a registered cohort")
const base = process.env.SERVER_URL!
const database = new SQL(process.env.DIRECT_DATABASE_URL!)
const duration = Number(process.env.SECONDS ?? "20") * 1000
const warmup = Number(process.env.WARMUP_SECONDS ?? "3") * 1000
if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(warmup) || warmup < 0)
  throw new Error("SECONDS must be positive and WARMUP_SECONDS nonnegative")
const diagnostic = process.env.DIAGNOSTIC === "1"
const expected = new Map<number, number>()
const replies = new Map<number, Set<number>>()
const failureDetails: Array<string> = []
let successes = 0
let attempts = 0
let failures = 0
let refusals = 0
let timeouts = 0
let dropped = 0
let newKey = 0
let maxSchedulerLagMs = 0
let warmupRefusals = 0
const latencies: Array<number> = []
const randomKey = keySequence(Math.max(1, scenario.keys))
const snapshot = async (gc = false) => {
  const response = await fetch(`${base}/${gc ? "gc" : "measure"}`, { method: "POST" })
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`)
  return decodeSnapshot(await response.text())
}

const request = async (
  key: number,
  read: boolean,
  record: boolean,
  scheduled = performance.now(),
  setup = false,
) => {
  const issued = Date.now()
  if (record) attempts += 1
  try {
    const headers = new Headers({ "content-type": "application/json" })
    if (!read) headers.set("idempotency-key", `v1.${issued}.${issued + 86_400_000}.${randomUUID()}`)
    const response = await fetch(
      `${base}/actors/BenchCounter/key-${key}/${read ? "Read" : "Increment"}`,
      {
        method: "POST",
        headers,
        body: read ? undefined : '{"by":3}',
        signal: AbortSignal.timeout(30_000),
      },
    )
    const text = await response.text()
    if (!response.ok) {
      if (!record) {
        if (setup || response.status !== 503)
          throw new Error(`Setup/warmup ${response.status}: ${text}`)
        warmupRefusals += 1
        return
      }
      if (response.status === 503) refusals += 1
      else failures += 1
      if (failureDetails.length < 20) failureDetails.push(`${response.status}: ${text}`)
      return
    }
    const value = decodeReply(text)
    if (read) {
      if (value !== expected.get(key))
        throw new Error(`Read ${key}: ${value} != ${expected.get(key)}`)
    } else {
      expected.set(key, (expected.get(key) ?? 0) + 3)
      const values = replies.get(key) ?? new Set<number>()
      if (values.has(value)) throw new Error(`Duplicate committed value for key ${key}: ${value}`)
      values.add(value)
      replies.set(key, values)
    }
    if (record) {
      successes += 1
      latencies.push(performance.now() - scheduled)
    }
  } catch (error) {
    if (!record) throw error
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      timeouts += 1
    else failures += 1
    if (failureDetails.length < 20) failureDetails.push(String(error))
  }
}

const untilReady = performance.now() + 120_000
while (true) {
  try {
    if ((await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok) break
  } catch {}
  if (performance.now() > untilReady) throw new Error("Runner did not become ready")
  await Bun.sleep(250)
}

await database`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`
const baselineMemory = await snapshot(true)
let nextSeed = 0
await Promise.all(
  Array.from({ length: 64 }, async () => {
    while (nextSeed < scenario.keys)
      await request(nextSeed++, false, false, performance.now(), true)
  }),
)

const load = async (milliseconds: number, record: boolean) => {
  const started = performance.now()
  const until = started + milliseconds
  if (scenario.rate === null) {
    await Promise.all(
      Array.from({ length: scenario.callers }, async () => {
        while (performance.now() < until) {
          const key = scenario.operation === "new" ? newKey++ : randomKey()
          await request(key, scenario.operation === "read", record)
        }
      }),
    )
    return
  }
  const rate = scenario.rate
  const pending = new Set<Promise<void>>()
  const offered = Math.floor((milliseconds * rate) / 1000)
  for (let index = 0; index < offered; index++) {
    const due = started + (index * 1000) / rate
    while (performance.now() < due) await Bun.sleep(Math.max(1, due - performance.now()))
    const lag = performance.now() - due
    if (record) maxSchedulerLagMs = Math.max(maxSchedulerLagMs, lag)
    if (pending.size >= 4096) {
      if (!record) throw new Error("Warmup exhausted the driver in-flight bound")
      attempts += 1
      dropped += 1
      continue
    }
    const command = request(randomKey(), false, record, due).finally(() => pending.delete(command))
    pending.add(command)
  }
  await Promise.all(pending)
}

const sleeping = scenario.operation === "idle" || scenario.operation === "cold"
const wakeEvidence: Array<{
  readonly resident: number
  readonly coldPointers: number
  readonly storedKeys: number
}> = []
if (!sleeping && scenario.operation !== "resident") await load(warmup, false)
const receipts = async () => {
  const rows = await database<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM actor_receipts`
  return Number(rows[0]!.count)
}
const initialReceipts = await receipts()
const pgCpu = async () => {
  const rows = await database<
    { stat: string }[]
  >`SELECT pg_read_file('/sys/fs/cgroup/cpu.stat') AS stat`
  const line = rows[0]!.stat.split("\n").find((entry) => entry.startsWith("usage_usec "))
  if (line === undefined) throw new Error("Postgres cgroup CPU unavailable")
  return Number(line.split(" ")[1])
}
const waitForSleep = async () => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    const resident = (await snapshot()).resident
    if (resident === 0) {
      const rows = await database<{ count: string }[]>`
        SELECT count(*)::text AS count FROM actor_generations WHERE cold_ref IS NOT NULL`
      const states = await database<{ count: string }[]>`
        SELECT count(*)::text AS count FROM actor_state WHERE actor_type = 'BenchCounter'`
      const coldPointers = Number(rows[0]!.count)
      const storedKeys = Number(states[0]!.count)
      if (
        (scenario.operation === "cold" && coldPointers === 1 && storedKeys === 0) ||
        (scenario.operation === "idle" && coldPointers === 0 && storedKeys === 1)
      ) {
        wakeEvidence.push({ resident, coldPointers, storedKeys })
        return
      }
    }
    await Bun.sleep(100)
  }
  throw new Error("No observed hibernation/cold pointer before wake")
}
if (sleeping) await waitForSleep()
await database`SELECT pg_stat_statements_reset()`
const pgStart = await pgCpu()
const start = await snapshot(scenario.operation === "resident")
const measuredStart = performance.now()
if (sleeping) {
  const repeats = Number(process.env.WAKE_REPEATS ?? "5")
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("WAKE_REPEATS must be a positive integer")
  for (let index = 0; index < repeats; index++) {
    if (index > 0) await waitForSleep()
    await request(0, false, true)
  }
} else if (scenario.operation === "resident") {
  await request(0, true, true)
} else await load(duration, true)
const elapsedMs = performance.now() - measuredStart
const end = await snapshot(scenario.operation === "resident")
const pgEnd = await pgCpu()
const sql = await database<{ query: string; calls: string; total_exec_time: number }[]>`
  SELECT query, calls::text, total_exec_time FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND query NOT LIKE '%pg_read_file%'
    AND query NOT LIKE '%pg_stat_statements%'
    AND query NOT LIKE '%count(*)::text AS count FROM actor_generations%'
    AND query NOT LIKE '%count(*)::text AS count FROM actor_state%'
  ORDER BY total_exec_time DESC`
const finalReceipts = await receipts()
const stored = await database<{ actor_id: string; value: Uint8Array }[]>`
  SELECT actor_id, value FROM actor_state WHERE actor_type = 'BenchCounter' AND key = 'count'`
let agreement = stored.length === expected.size
for (const row of stored) {
  const key = Number(row.actor_id.replace("key-", ""))
  const value = Number(new TextDecoder().decode(Bun.zstdDecompressSync(row.value)))
  if (value !== expected.get(key)) agreement = false
}
for (const [key, count] of expected) {
  const values = replies.get(key)!
  if (values.size !== count / 3) agreement = false
  for (let value = 3; value <= count; value += 3) if (!values.has(value)) agreement = false
}
const acknowledgedWrites = [...expected.values()].reduce((sum, count) => sum + count / 3, 0)
if (finalReceipts !== acknowledgedWrites) agreement = false
if (
  finalReceipts - initialReceipts !==
  (scenario.operation === "read" || scenario.operation === "resident" ? 0 : successes)
)
  agreement = false
if (sleeping && end.resident !== 1) agreement = false
if (scenario.operation === "cold") {
  const rows = await database<{ count: string }[]>`
    SELECT count(*)::text AS count FROM actor_generations WHERE cold_ref IS NOT NULL`
  if (Number(rows[0]!.count) !== 0) agreement = false
}
const result: Result = {
  schemaVersion: 1,
  sha: process.env.SHA!,
  case: scenario.name,
  diagnostic,
  attempts,
  successes,
  failures,
  refusals,
  timeouts,
  dropped,
  elapsedMs,
  valid:
    agreement &&
    failures === 0 &&
    timeouts === 0 &&
    dropped === 0 &&
    refusals === 0 &&
    successes > 0,
  metrics: {
    throughput:
      sleeping || scenario.operation === "resident" ? null : (successes * 1000) / elapsedMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: percentile(latencies, 1),
    appCpuMsPerSuccess:
      successes === 0 || scenario.operation === "resident"
        ? null
        : (end.cpu.user + end.cpu.system - start.cpu.user - start.cpu.system) / 1000 / successes,
    databaseCpuMsPerSuccess:
      successes === 0 || scenario.operation === "resident"
        ? null
        : (pgEnd - pgStart) / 1000 / successes,
    sqlElapsedMsPerSuccess:
      successes === 0 || scenario.operation === "resident"
        ? null
        : sql.reduce((sum, row) => sum + row.total_exec_time, 0) / successes,
    flightsPerSuccess:
      diagnostic && successes > 0 ? (end.flights - start.flights) / successes : null,
    statementsPerSuccess:
      diagnostic && successes > 0 ? (end.statements - start.statements) / successes : null,
    rssBytesPerResident:
      scenario.operation === "resident" && end.resident === scenario.keys
        ? (end.rss - baselineMemory.rss) / end.resident
        : null,
  },
}
await Bun.write(
  process.env.OUTPUT!,
  JSON.stringify(
    {
      ...result,
      scenario,
      durationMs: duration,
      warmupMs: warmup,
      maxSchedulerLagMs,
      warmupRefusals,
      wakeEvidence,
      agreement,
      failureDetails,
      initialReceipts,
      finalReceipts,
      start,
      end,
      baselineMemory,
      pgStart,
      pgEnd,
      sql,
      latencyMs: latencies,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify(result))
await database.close()
await fetch(`${base}/exit`, { method: "POST" })
if (!agreement || failures > 0 || timeouts > 0 || dropped > 0) process.exitCode = 1
