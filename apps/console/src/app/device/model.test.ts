import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  accessScope,
  clientLabel,
  deviceProblem,
  displayUserCode,
  normalizeUserCode,
} from "./model.ts"

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
  const refusal = (status: number, error?: string) => deviceProblem({ status, error })

  it("names each refusal the device routes answer", () => {
    expect([
      refusal(400, "invalid_request"),
      refusal(400, "expired_token"),
      refusal(403, "access_denied"),
      refusal(429),
      refusal(401, "unauthorized"),
      refusal(0),
      refusal(500, "server_error"),
      refusal(404),
    ]).toEqual([
      "invalid",
      "expired",
      "elsewhere",
      "slowDown",
      "Unauthorized",
      "unreachable",
      "unreachable",
      "unreachable",
    ])
  })

  it("calls a code expired only when the server says expired_token", () => {
    expect([refusal(400, "invalid_request"), refusal(400), refusal(400, "expired_token")]).toEqual([
      "invalid",
      "unreachable",
      "expired",
    ])
  })

  it("lets the status decide before the error, so a rate limit is never read as a bad code", () => {
    expect(refusal(429, "invalid_request")).toBe("slowDown")
    expect(refusal(401, "access_denied")).toBe("Unauthorized")
  })
})

describe("device access", () => {
  it("names one organization, counts several, and says when there are none", () => {
    expect([
      accessScope([]),
      accessScope(["Acme"]),
      accessScope(["Acme", "Globex", "Initech"]),
    ]).toEqual(["No organizations yet", "Acme", "All your organizations (3)"])
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
