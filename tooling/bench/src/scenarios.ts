/** A served workload's offered load and key distribution, fixed across both refs. */
export interface Scenario {
  readonly name: string
  readonly operation: "write" | "read" | "new" | "idle" | "cold" | "resident"
  readonly keys: number
  readonly callers: number
  readonly rate: number | null
}

/** Explicit cohorts prevent a hot-key-only score from standing in for ordinary traffic. */
export const scenarios: ReadonlyArray<Scenario> = [
  { name: "sequential-write", operation: "write", keys: 1, callers: 1, rate: null },
  { name: "hot-write", operation: "write", keys: 1, callers: 64, rate: null },
  { name: "spread-write", operation: "write", keys: 10_000, callers: 64, rate: null },
  { name: "sequential-read", operation: "read", keys: 1, callers: 1, rate: null },
  { name: "spread-read", operation: "read", keys: 1_000, callers: 64, rate: null },
  { name: "new-key", operation: "new", keys: 0, callers: 1, rate: null },
  ...[200, 500, 1_000, 2_000].map((rate): Scenario => ({
    name: `open-write-${rate}`,
    operation: "write",
    keys: 1_000,
    callers: 0,
    rate,
  })),
  { name: "idle-wake", operation: "idle", keys: 1, callers: 1, rate: null },
  { name: "cold-wake", operation: "cold", keys: 1, callers: 1, rate: null },
  { name: "resident", operation: "resident", keys: 10_000, callers: 64, rate: null },
]

/** Fixed unsigned arithmetic gives both revisions exactly the same key stream. */
export const keySequence = (keys: number) => {
  let random = 0x12345678
  return () => {
    random ^= random << 13
    random ^= random >>> 17
    random ^= random << 5
    return (random >>> 0) % keys
  }
}
