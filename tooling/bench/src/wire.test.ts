import { expect, it } from "vitest"
import { frontendCounter } from "./wire.ts"

it("does not lose fragmented Execute frames or count startup, Bind and Sync as statements", () => {
  const startup = Buffer.from([0, 0, 0, 8, 0, 3, 0, 0])
  const bind = Buffer.from([66, 0, 0, 0, 4])
  const execute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0])
  const sync = Buffer.from([83, 0, 0, 0, 4])
  const messages = Buffer.concat([startup, bind, execute, execute, sync])
  for (let split = 0; split <= messages.length; split++) {
    const count = frontendCounter()
    expect(count(messages.subarray(0, split)) + count(messages.subarray(split))).toBe(2)
  }
  const count = frontendCounter()
  expect(count(startup)).toBe(0)
  expect(() => count(Buffer.from([69, 0, 0, 0, 1]))).toThrow("Invalid Postgres")
})
