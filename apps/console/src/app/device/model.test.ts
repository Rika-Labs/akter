import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { clientLabel, deviceProblem, displayUserCode, normalizeUserCode } from "./model.ts"

describe("device user codes", () => {
  it("reads a code in any case, with or without its dash or stray spaces", () => {
    expect(
      ["WDJB-MJHT", "wdjb-mjht", "WDJBMJHT", "wdjbmjht", " wDjB mjHt ", "WD-JB-MJ-HT"].map(
        normalizeUserCode,
      ),
    ).toEqual(Array.from({ length: 6 }, () => Option.some("WDJBMJHT")))
  })

  it("refuses anything the CLI could not have printed", () => {
    expect(
      [
        "",
        "WDJB-MJH",
        "WDJB-MJHTX",
        "WDJB_MJHT",
        "WDJB-MJH0",
        "WDJB-MJH1",
        "WDJB-MJHI",
        "WDJB-MJHO",
        "WDJB-MJH%",
      ].map(normalizeUserCode),
    ).toEqual(Array.from({ length: 9 }, () => Option.none()))
  })

  it("shows a stored code as two groups of four", () => {
    expect(displayUserCode("WDJBMJHT")).toBe("WDJB-MJHT")
  })
})

describe("device refusals", () => {
  const lookup = (status: number, error?: string) =>
    deviceProblem({ failure: { status, error }, stage: "lookup" })
  const decision = (status: number, error?: string) =>
    deviceProblem({ failure: { status, error }, stage: "decision" })

  it("names each refusal the lookup can answer", () => {
    expect([
      lookup(400, "invalid_request"),
      lookup(400, "expired_token"),
      lookup(429),
      lookup(401, "unauthorized"),
      lookup(0),
      lookup(500, "server_error"),
      lookup(404),
    ]).toEqual([
      "invalid",
      "expired",
      "slowDown",
      "Unauthorized",
      "unreachable",
      "unreachable",
      "unreachable",
    ])
  })

  it("reads a decision's invalid request as a code decided or redeemed since it was looked up", () => {
    expect([
      decision(400, "invalid_request"),
      decision(400, "expired_token"),
      decision(403, "access_denied"),
      decision(401, "unauthorized"),
      decision(429),
      decision(502),
    ]).toEqual(["used", "expired", "elsewhere", "Unauthorized", "slowDown", "unreachable"])
  })

  it("lets the status decide before the error, so a rate limit is never read as a bad code", () => {
    expect(lookup(429, "invalid_request")).toBe("slowDown")
    expect(decision(401, "access_denied")).toBe("Unauthorized")
  })
})

describe("device clients", () => {
  it("names the Akter CLI and shows any other client id as it is", () => {
    expect(clientLabel("akter-cli")).toEqual({
      name: "Akter CLI",
      detail: "The Akter command line on your computer",
    })
    expect(clientLabel("unknown-app")).toEqual({ name: "unknown-app" })
  })
})
