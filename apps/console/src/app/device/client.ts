import { Effect, Predicate } from "effect"
import { cloud, ConsoleError, fixturesEnabled, type Loaded } from "../api/client.ts"
import { auth } from "../auth/session.ts"
import {
  clientLabel,
  DeviceDecided,
  DeviceEntry,
  type DeviceFailure,
  DevicePage,
  type DeviceProblem,
  deviceProblem,
  DeviceRefused,
  DeviceReview,
} from "./model.ts"

/** The page before any code is looked up; a code in the URL only fills the field. */
export const loadDevice = Effect.sync((): Loaded<DevicePage> => ({
  data: DevicePage.make({ step: DeviceEntry.make({}) }),
  sample: fixturesEnabled(),
}))

const signedOut = ConsoleError.make({ kind: "Unauthorized", message: "Sign in to continue." })

const refusedPage = (code: string, problem: DeviceProblem) =>
  DevicePage.make({ step: DeviceRefused.make({ code, problem }) })

const refused = (
  code: string,
  failure: DeviceFailure,
  stage: "lookup" | "decision",
): Effect.Effect<DevicePage, ConsoleError> => {
  const problem = deviceProblem({ failure, stage })
  return problem === "Unauthorized"
    ? Effect.fail(signedOut)
    : Effect.succeed(refusedPage(code, problem))
}

/**
 * The review of a code bound to this account. The account and organization are read the way the
 * rest of the console reads them: the active membership, or the first one.
 */
const review = (code: string, clientId: string): Effect.Effect<DevicePage, ConsoleError> =>
  Effect.gen(function* () {
    const api = yield* cloud
    const me = yield* api.account.me()
    const membership =
      me.organizations.find((item) => item.organization.id === me.activeOrganizationId) ??
      me.organizations[0]
    const client = clientLabel(clientId)
    return DevicePage.make({
      step: DeviceReview.make({
        code,
        client: client.name,
        clientDetail: client.detail,
        name: me.user?.name ?? "",
        email: me.user?.email ?? "",
        organization: membership?.organization.name,
      }),
    })
  }).pipe(
    Effect.catch((error) =>
      Predicate.isTagged(error, "Unauthorized")
        ? Effect.fail(signedOut)
        : Effect.succeed(refusedPage(code, "unreachable")),
    ),
  )

/**
 * Looks the code up while signed in, which binds a pending, unclaimed code to this account, and
 * offers it for review only when the control plane names its client: Better Auth names it only to
 * the account the code is bound to. A code that was approved or denied is used; a pending one with
 * no client is bound to someone else.
 */
export const lookUpDevice = (code: string): Effect.Effect<DevicePage, ConsoleError> =>
  auth.lookUpDevice(code).pipe(
    Effect.matchEffect({
      onFailure: (failure) => refused(code, failure, "lookup"),
      onSuccess: (answer) => {
        if (answer.status !== "pending") return Effect.succeed(refusedPage(code, "used"))
        if (answer.client_id === undefined) return Effect.succeed(refusedPage(code, "elsewhere"))
        return review(code, answer.client_id)
      },
    }),
  )

/** Approves or denies a reviewed code; a refusal says why the code can no longer be decided. */
export const decideDevice = ({
  code,
  decision,
}: Readonly<{ code: string; decision: "approved" | "denied" }>): Effect.Effect<
  DevicePage,
  ConsoleError
> =>
  (decision === "approved" ? auth.approveDevice(code) : auth.denyDevice(code)).pipe(
    Effect.matchEffect({
      onFailure: (failure) => refused(code, failure, "decision"),
      onSuccess: () =>
        Effect.succeed(DevicePage.make({ step: DeviceDecided.make({ code, decision }) })),
    }),
  )
