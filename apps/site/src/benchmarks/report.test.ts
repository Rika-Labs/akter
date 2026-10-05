import { describe, expect, it } from "vitest"
import { crashTest, hotKey, latency } from "./report.ts"

describe("the benchmark report as the home page reads it", () => {
  it("charts Akter's hot-key writes first, with every collected system measured", () => {
    expect(hotKey[0]?.system).toBe("Akter")
    expect(hotKey.length).toBeGreaterThan(1)
    expect(hotKey.every((row) => row.operationsPerSecond > 0)).toBe(true)
  })

  it("reads latencies as milliseconds, not operations per second", () => {
    expect(latency.write).toBeGreaterThan(0)
    expect(latency.write).toBeLessThan(100)
    expect(latency.freshRead).toBeLessThan(latency.write)
  })

  it("totals the final crash control across its drills with nothing lost or repeated", () => {
    expect(crashTest.acknowledged).toBeGreaterThan(1000)
    expect(crashTest.missing).toBe(0)
    expect(crashTest.repeated).toBe(0)
    expect(crashTest.unknown).toBe(0)
  })
})
