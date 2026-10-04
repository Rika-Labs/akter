import type { DBAdapter } from "@better-auth/core/db/adapter"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"
import { Clock, Effect, Option, Schema } from "effect"

/** The one client the device authorization grant accepts: the `akter` CLI. */
export const CLI_CLIENT_ID = "akter-cli"

/** The verification record that carries an approver's active organization to the session its code redeems. */
const organizationRecord = (deviceCode: string) =>
  `akter-device-organization:${new Bun.CryptoHasher("sha256").update(deviceCode).digest("hex")}`

const DeviceCodeRow = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  userId: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  expiresAt: Schema.Date,
})

const CodeRequest = Schema.Struct({ user_id: Schema.optional(Schema.String) })

const Lookup = Schema.Struct({ user_code: Schema.String })

const Approval = Schema.Struct({ userCode: Schema.String })

const Redemption = Schema.Struct({ device_code: Schema.String })

const ActiveOrganization = Schema.Struct({ activeOrganizationId: Schema.String })

/**
 * Finds a code the way the device plugin does: the exact user code, then the
 * code with separators removed and upper-cased, so `WDJB-MJHT` and
 * `wdjbmjht` name the same code.
 */
const findByUserCode = (adapter: DBAdapter, userCode: string) =>
  Effect.gen(function* () {
    for (const value of [userCode, userCode.replace(/[^a-zA-Z0-9]/gu, "").toUpperCase()]) {
      const row = yield* Effect.promise(() =>
        adapter.findOne({ model: "deviceCode", where: [{ field: "userCode", value }] }),
      )
      const found = Schema.decodeUnknownOption(DeviceCodeRow)(row)

      if (Option.isSome(found) && found.value.userCode === value) return found
    }

    return Option.none<typeof DeviceCodeRow.Type>()
  })

/** The `user_id` fields of a form-encoded `/device/code` body, which the plugin also reads. */
const formUserIds = (request: Request | undefined) =>
  request?.headers.get("content-type")?.includes("application/x-www-form-urlencoded") === true
    ? Effect.promise(() => request.clone().text()).pipe(
        Effect.map((body) => new URLSearchParams(body).getAll("user_id")),
      )
    : Effect.succeed([])

/** Throws a hook's refusal, as Better Auth expects a hook to refuse a request. */
const refuse = (refusal: Promise<APIError | undefined>) =>
  refusal.then((error) => {
    if (error !== undefined) throw error
  })

/**
 * Policy the device authorization plugin leaves to its host:
 *
 * - `/device/code` refuses `user_id`, which would let an unauthenticated
 *   caller bind a new code to any account before anyone verifies it.
 * - `/device` refuses, as `access_denied`, a signed-in viewer looking up a
 *   pending code another account already claimed, instead of answering a
 *   status with the client hidden.
 * - An approval records the approver's active organization, and the session
 *   the code then redeems starts in it, as the browser session did.
 */
export const devicePolicy = {
  id: "akter-device-policy",
  hooks: {
    before: [
      {
        matcher: (context) => context.path === "/device/code",
        handler: createAuthMiddleware((ctx) =>
          Effect.gen(function* () {
            const bound = Option.flatMap(
              Schema.decodeUnknownOption(CodeRequest)(ctx.body),
              (body) => Option.fromNullishOr(body.user_id),
            )
            const form = yield* formUserIds(ctx.request)

            if (
              Option.exists(bound, (userId) => userId !== "") ||
              form.some((userId) => userId !== "")
            )
              return new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "A device code is bound by the person who approves it",
              })
          }).pipe(Effect.runPromise, refuse),
        ),
      },
      {
        matcher: (context) => context.path === "/device",
        handler: createAuthMiddleware((ctx) =>
          Effect.gen(function* () {
            const viewer = yield* Effect.promise(() => getSessionFromCtx(ctx))
            const lookup = Schema.decodeUnknownOption(Lookup)(ctx.query)

            if (viewer === null || Option.isNone(lookup)) return

            const found = yield* findByUserCode(ctx.context.adapter, lookup.value.user_code)
            const now = yield* Clock.currentTimeMillis

            if (
              Option.exists(
                found,
                (code) =>
                  code.status === "pending" &&
                  code.expiresAt.getTime() > now &&
                  code.userId !== undefined &&
                  code.userId !== null &&
                  code.userId !== viewer.user.id,
              )
            )
              return new APIError("FORBIDDEN", {
                error: "access_denied",
                error_description: "This code was claimed by another account",
              })
          }).pipe(Effect.runPromise, refuse),
        ),
      },
    ],
    after: [
      {
        matcher: (context) => context.path === "/device/approve",
        handler: createAuthMiddleware((ctx) =>
          Effect.gen(function* () {
            if (isAPIError(ctx.context.returned)) return

            const approver = yield* Effect.promise(() => getSessionFromCtx(ctx))
            const organization = Schema.decodeUnknownOption(ActiveOrganization)(approver?.session)
            const approval = Schema.decodeUnknownOption(Approval)(ctx.body)

            if (Option.isNone(organization) || Option.isNone(approval)) return

            const found = yield* findByUserCode(ctx.context.adapter, approval.value.userCode)

            if (Option.isNone(found)) return

            yield* Effect.promise(() =>
              ctx.context.internalAdapter.createVerificationValue({
                identifier: organizationRecord(found.value.deviceCode),
                value: organization.value.activeOrganizationId,
                expiresAt: found.value.expiresAt,
              }),
            )
          }).pipe(Effect.runPromise),
        ),
      },
      {
        matcher: (context) => context.path === "/device/token",
        handler: createAuthMiddleware((ctx) =>
          Effect.gen(function* () {
            const created = ctx.context.newSession
            const redemption = Schema.decodeUnknownOption(Redemption)(ctx.body)

            if (created === null || isAPIError(ctx.context.returned) || Option.isNone(redemption))
              return

            const identifier = organizationRecord(redemption.value.device_code)
            const recorded = yield* Effect.promise(() =>
              ctx.context.internalAdapter.findVerificationValue(identifier),
            )

            if (recorded === null) return

            yield* Effect.promise(() =>
              ctx.context.internalAdapter.updateSession(created.session.token, {
                activeOrganizationId: recorded.value,
              }),
            )
            yield* Effect.promise(() =>
              ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier),
            )
          }).pipe(Effect.runPromise),
        ),
      },
    ],
  },
} satisfies BetterAuthPlugin
