import { Match, Option, Schema as S } from "effect"

/**
 * The letters Better Auth's device authorization plugin draws user codes from. It leaves out `0`,
 * `1`, `I` and `O`, which read alike, so a code holding one of them was mistyped.
 */
const userCodePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

/**
 * The code a person typed or a link carried, as the control plane stores it: eight letters and
 * digits in upper case. Case, spaces and the dash between the halves are ignored; anything else is
 * not a code the CLI could have printed.
 */
export const normalizeUserCode = (typed: string): Option.Option<string> => {
  const compact = typed.replace(/[\s-]/g, "").toUpperCase()
  return userCodePattern.test(compact) ? Option.some(compact) : Option.none()
}

/** A stored code as people read it, two groups of four: `ABCD-EFGH`. */
export const displayUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * Why a code can't be approved here: not valid, past its lifetime as the server reports it,
 * claimed by another signed-in account, refused for too many attempts, or not answered at all.
 * An unknown code and one already approved or denied are one state, because the server deletes a
 * code once the CLI redeems or learns of its denial, so a used code usually reads as unknown.
 */
export const DeviceProblem = S.Literals([
  "invalid",
  "expired",
  "elsewhere",
  "slowDown",
  "unreachable",
])
export type DeviceProblem = typeof DeviceProblem.Type

/** No code has been looked up yet; the page asks for one. */
export const DeviceEntry = S.TaggedStruct("DeviceEntry", {})

/**
 * A code the control plane confirmed is pending and bound to this account: who asked, the account
 * approving it signs in as, and the organizations that session can act in.
 */
export const DeviceReview = S.TaggedStruct("DeviceReview", {
  code: S.String,
  client: S.String,
  clientDetail: S.optional(S.String),
  name: S.String,
  email: S.String,
  access: S.String,
})
export type DeviceReview = typeof DeviceReview.Type

/** A code that can't be approved, and why. */
export const DeviceRefused = S.TaggedStruct("DeviceRefused", {
  code: S.String,
  problem: DeviceProblem,
})

/** A code this person approved or denied. */
export const DeviceDecided = S.TaggedStruct("DeviceDecided", {
  code: S.String,
  decision: S.Literals(["approved", "denied"]),
})

/**
 * The device sign-in page at one of its steps. `pending` is the code a lookup or decision is in
 * flight for, so only the answer for that code can replace the step.
 */
export const DevicePage = S.TaggedStruct("DevicePage", {
  step: S.Union([DeviceEntry, DeviceReview, DeviceRefused, DeviceDecided]),
  pending: S.optional(S.String),
})
export type DevicePage = typeof DevicePage.Type

/** A refusal from Better Auth's device routes: the HTTP status and its OAuth `error`, if any. */
export interface DeviceFailure {
  readonly status: number
  readonly error?: string | undefined
}

/**
 * What a refused lookup (`GET /device`) or decision (`POST /device/approve` or `/deny`) means for
 * the person, or `Unauthorized` when the session ended. `invalid_request` covers an unknown code
 * and one already decided or redeemed, which the server can't tell apart once it deletes the code.
 */
export const deviceProblem = (failure: DeviceFailure): DeviceProblem | "Unauthorized" =>
  Match.value(failure).pipe(
    Match.when({ status: 401 }, () => "Unauthorized" as const),
    Match.when({ status: 429 }, () => "slowDown" as const),
    Match.when({ error: "expired_token" }, () => "expired" as const),
    Match.when({ error: "access_denied" }, () => "elsewhere" as const),
    Match.when({ error: "invalid_request" }, () => "invalid" as const),
    Match.orElse(() => "unreachable" as const),
  )

/**
 * What an approved session can reach. Better Auth mints it as a session for the person, and the API
 * authorizes sessions by membership alone, so it can act in every organization they belong to,
 * whichever one is active in this browser.
 */
export const accessScope = (organizations: ReadonlyArray<string>): string => {
  if (organizations.length === 0) return "No organizations yet"
  if (organizations.length === 1) return organizations[0] ?? ""
  return `All your organizations (${String(organizations.length)})`
}

/**
 * Names the clients the control plane accepts. Better Auth reports only a client id, so the
 * console owns the words; an unknown id is shown as it is rather than dressed up as a known app.
 */
const clients: ReadonlyMap<string, Readonly<{ name: string; detail: string }>> = new Map([
  ["akter-cli", { name: "Akter CLI", detail: "The Akter command line on your computer" }],
])

/** The name and description a review shows for the client that asked for a code. */
export const clientLabel = (clientId: string): Readonly<{ name: string; detail?: string }> =>
  clients.get(clientId) ?? { name: clientId }
