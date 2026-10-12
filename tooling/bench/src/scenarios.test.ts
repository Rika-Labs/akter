import { expect, it } from "vitest"
import { keySequence, scenarios } from "./scenarios.ts"

it("keeps open-loop offered rates separate and spread key streams reproducible", () => {
  expect(scenarios.flatMap((scenario) => (scenario.rate === null ? [] : [scenario.rate]))).toEqual([
    200, 500, 1_000, 2_000,
  ])
  expect(new Set(scenarios.map((scenario) => scenario.name)).size).toBe(scenarios.length)
  const first = keySequence(10_000)
  const second = keySequence(10_000)
  const keys = Array.from({ length: 100 }, first)
  expect(keys).toEqual(Array.from({ length: 100 }, second))
  expect(new Set(keys).size).toBeGreaterThan(90)
  expect(keys.every((key) => key >= 0 && key < 10_000)).toBe(true)
})
