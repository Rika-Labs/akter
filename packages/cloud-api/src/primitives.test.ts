import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  ActorAddress,
  BillingPeriod,
  CalendarDay,
  CommitSha,
  Email,
  EnvironmentName,
  InviteRole,
  Name,
  Page,
  pageQuery,
  RegionId,
  Slug,
} from "./primitives.ts"

type Wire = Schema.Json

const accepts = <T, E>(schema: Schema.Codec<T, E>, value: Wire) =>
  Exit.isSuccess(Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(value)))

describe("primitives", () => {
  it("accepts slugs with inner hyphens and rejects edges, case and length", () => {
    expect(["a", "acme-labs", "a1", "x".repeat(40)].map((v) => accepts(Slug, v))).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(
      ["", "-a", "a-", "Acme", "a_b", "x".repeat(41), "a b"].map((v) => accepts(Slug, v)),
    ).toEqual([false, false, false, false, false, false, false])
  })

  it("rejects display names with outer blanks or past 100 characters", () => {
    expect(accepts(Name, "Acme Labs")).toBe(true)
    expect(accepts(Name, " Acme")).toBe(false)
    expect(accepts(Name, "Acme ")).toBe(false)
    expect(accepts(Name, "x".repeat(100))).toBe(true)
    expect(accepts(Name, "x".repeat(101))).toBe(false)
  })

  it("requires an email with a domain dot", () => {
    expect(accepts(Email, "ada@acme.dev")).toBe(true)
    expect(accepts(Email, "ada@acme")).toBe(false)
    expect(accepts(Email, "ada acme@x.dev")).toBe(false)
  })

  it("limits closed vocabularies to the ones the console knows", () => {
    expect(accepts(EnvironmentName, "staging")).toBe(true)
    expect(accepts(EnvironmentName, "prod")).toBe(false)
    expect(accepts(RegionId, "us-west-2")).toBe(true)
    expect(accepts(RegionId, "eu-west-1")).toBe(false)
    expect(accepts(InviteRole, "owner")).toBe(false)
    expect(accepts(InviteRole, "viewer")).toBe(true)
  })

  it("checks calendar days, billing periods, commit SHAs and actor addresses by shape", () => {
    expect(accepts(CalendarDay, "2026-10-03")).toBe(true)
    expect(accepts(CalendarDay, "2026-1-3")).toBe(false)
    expect(accepts(BillingPeriod, "2026-12")).toBe(true)
    expect(accepts(BillingPeriod, "2026-13")).toBe(false)
    expect(accepts(BillingPeriod, "2026-00")).toBe(false)
    expect(accepts(CommitSha, "e95e806")).toBe(true)
    expect(accepts(CommitSha, "e95e80")).toBe(false)
    expect(accepts(CommitSha, "E95E806")).toBe(false)
    expect(accepts(ActorAddress, "Counter/room-1")).toBe(true)
    expect(accepts(ActorAddress, "Counter/a/b")).toBe(true)
    expect(accepts(ActorAddress, "Counter")).toBe(false)
    expect(accepts(ActorAddress, "/key")).toBe(false)
  })

  it("bounds page size to 1 through 100", () => {
    const query = Schema.Struct(pageQuery)
    expect(accepts(query, { limit: 100 })).toBe(true)
    expect(accepts(query, { limit: 1, cursor: "abc" })).toBe(true)
    expect(accepts(query, {})).toBe(true)
    expect(accepts(query, { limit: 0 })).toBe(false)
    expect(accepts(query, { limit: 101 })).toBe(false)
    expect(accepts(query, { limit: 1.5 })).toBe(false)
  })

  it("distinguishes the last page by a null cursor", () => {
    const page = Page(Schema.String)
    expect(accepts(page, { items: ["a"], nextCursor: null })).toBe(true)
    expect(accepts(page, { items: ["a"] })).toBe(false)
  })
})
