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
 * Why a code can't be approved here: unknown, past its lifetime, already approved or denied,
 * claimed by another signed-in account, refused for too many attempts, or not answered at all.
 */
export const DeviceProblem = S.Literals([
  "invalid",
  "expired",
  "used",
  "elsewhere",
  "slowDown",
  "unreachable",
])
export type DeviceProblem = typeof DeviceProblem.Type

/** No code has been looked up yet; the page asks for one. */
export const DeviceEntry = S.TaggedStruct("DeviceEntry", {})

/**
 * A code the control plane confirmed is pending and bound to this account: who asked, and the
 * account and organization approving it would sign in.
 */
export const DeviceReview = S.TaggedStruct("DeviceReview", {
  code: S.String,
  client: S.String,
  clientDetail: S.optional(S.String),
  name: S.String,
  email: S.String,
  organization: S.optional(S.String),
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

/** The device sign-in page at one of its steps. */
export const DevicePage = S.TaggedStruct("DevicePage", {
  step: S.Union([DeviceEntry, DeviceReview, DeviceRefused, DeviceDecided]),
})
export type DevicePage = typeof DevicePage.Type

/** A refusal from Better Auth's device routes: the HTTP status and its OAuth `error`, if any. */
export interface DeviceFailure {
  readonly status: number
  readonly error?: string | undefined
}

/**
 * What a refused lookup (`GET /device`) or decision (`POST /device/approve` or `/deny`) means for
 * the person, or `Unauthorized` when the session ended. The lookup answers `invalid_request` only
 * for an unknown code. A decision follows a lookup that found the code pending and claimed, so its
 * `invalid_request` means the code was decided or redeemed since; redemption deletes the record.
 */
export const deviceProblem = (
  input: Readonly<{ failure: DeviceFailure; stage: "lookup" | "decision" }>,
): DeviceProblem | "Unauthorized" =>
  Match.value(input.failure).pipe(
    Match.when({ status: 401 }, () => "Unauthorized" as const),
    Match.when({ status: 429 }, () => "slowDown" as const),
    Match.when({ error: "expired_token" }, () => "expired" as const),
    Match.when({ error: "access_denied" }, () => "elsewhere" as const),
    Match.when({ error: "invalid_request" }, () =>
      input.stage === "lookup" ? ("invalid" as const) : ("used" as const),
    ),
    Match.orElse(() => "unreachable" as const),
  )

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
