import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { Conflict, Forbidden, NotFound, NotImplemented, Unauthorized, Unavailable } from "./errors.ts"

const expectRoundTrip = <T extends { readonly _tag: string }, E>(
  schema: Schema.Codec<T, E>,
  value: T,
) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Effect.runSync(Schema.encodeEffect(codec)(value))))
  expect(wire._tag).toBe(value._tag)
  expect(Effect.runSync(Schema.decodeUnknownEffect(codec)(wire))).toEqual(value)
}

describe("errors", () => {
  it("round-trips each error through its JSON wire form with its tag", () => {
    expectRoundTrip(
      Unauthorized,
      Unauthorized.make({ code: "expired", message: "session expired" }),
    )
    expectRoundTrip(Forbidden, Forbidden.make({ message: "viewers cannot deploy" }))
    expectRoundTrip(NotFound, NotFound.make({ resource: "project", id: "prj_1" }))
    expectRoundTrip(Conflict, Conflict.make({ message: "slug taken" }))
    expectRoundTrip(NotImplemented, NotImplemented.make({ operation: "deployments.create" }))
    expectRoundTrip(Unavailable, Unavailable.make({ message: "No ready capacity", retryAfterSeconds: 1 }))
  })

  it("answers each error with its own status", () => {
    const status = (schema: Schema.Top) => schema.ast.annotations?.["httpApiStatus"]
    expect([Unauthorized, Forbidden, NotFound, Conflict, NotImplemented, Unavailable].map(status)).toEqual([
      401, 403, 404, 409, 501, 503,
    ])
  })

  it("accepts only the credential codes the security contract names", () => {
    const accepts = (code: string) =>
      Exit.isSuccess(Schema.decodeUnknownExit(Unauthorized.fields.code)(code))
    expect(["missing_credentials", "invalid_credentials", "expired"].map(accepts)).toEqual([
      true,
      true,
      true,
    ])
    expect(accepts("access_denied")).toBe(false)
  })

  it("can be failed with and recovered by tag", () => {
    const recovered = Effect.runSync(
      Effect.fail(NotFound.make({ resource: "domain", id: "d_9" })).pipe(
        Effect.catchTag("NotFound", (error) => Effect.succeed(`${error.resource}:${error.id}`)),
      ),
    )
    expect(recovered).toBe("domain:d_9")
  })
})
