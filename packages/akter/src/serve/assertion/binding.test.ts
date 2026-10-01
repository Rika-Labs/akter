import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  type BoundRequest,
  canonicalPath,
  canonicalQuery,
  canonicalRequest,
  reauthenticationDigest,
  requestDigest,
} from "./binding.ts"

/** An independent SHA-256, so the digests aren't checked against themselves. */
const sha256 = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

const body = new TextEncoder().encode('{"reason":"late"}')

const cancel: BoundRequest = {
  method: "post",
  target: "/actors/Order/o-17/Cancel",
  idempotencyKey: "v1.1.2.k",
  body,
}

describe("the canonical request binding", () => {
  it("joins the version, method, path, query, idempotency key, and body hash by newlines", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const text = yield* canonicalRequest(cancel)

        expect(text).toBe(
          [
            "durable-assertion/v1",
            "POST",
            "/actors/Order/o-17/Cancel",
            "",
            "v1.1.2.k",
            sha256(body),
          ].join("\n"),
        )
        expect(yield* requestDigest(cancel)).toBe(sha256(text))
      }),
    ))

  it("writes an empty idempotency key and the empty body's hash when there are none", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const text = yield* canonicalRequest({
          method: "GET",
          target: "/actors/Room/r1/events?event=Said",
          idempotencyKey: undefined,
          body: new Uint8Array(0),
        })

        expect(text.split("\n").slice(3)).toEqual(["event=Said", "", sha256("")])
      }),
    ))

  it("uppercases percent-encoding, decodes unreserved escapes, and removes dot segments", () => {
    expect(canonicalPath("/actors/Room/a%2fb/Post")).toBe("/actors/Room/a%2Fb/Post")
    expect(canonicalPath("/actors/Room/%41%7e/Post")).toBe("/actors/Room/A~/Post")
    expect(canonicalPath("/actors/./Room/x/../y/Post")).toBe("/actors/Room/y/Post")
    expect(canonicalPath("/a/b/..")).toBe("/a/")
    expect(canonicalPath("/../a")).toBe("/a")
  })

  it("sorts query parameters by name then value and encodes each the same way", () => {
    expect(canonicalQuery("b=2&a=z&a=y")).toBe("a=y&a=z&b=2")
    expect(canonicalQuery("q=a%20b&q=a+c&x=%2a")).toBe("q=a%20b&q=a%20c&x=%2A")
    expect(canonicalQuery("")).toBe("")
  })

  it("gives a different digest when any bound part changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* requestDigest(cancel)

        const changed: ReadonlyArray<BoundRequest> = [
          { ...cancel, method: "PUT" },
          { ...cancel, target: "/actors/Order/o-18/Cancel" },
          { ...cancel, target: "/actors/Order/o-17/Refund" },
          { ...cancel, target: "/actors/Order/o-17/Cancel?x=1" },
          { ...cancel, idempotencyKey: "v1.1.2.other" },
          { ...cancel, body: new TextEncoder().encode('{"reason":"early"}') },
        ]

        for (const request of changed) expect(yield* requestDigest(request)).not.toBe(original)
      }),
    ))

  it("binds a reauthentication to the upgrade path and session id", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const digest = yield* reauthenticationDigest({
          path: "/actors/Room/r1/Chat?x=1",
          session: "c2lk",
        })

        const text = ["durable-assertion/v1", "REAUTHENTICATE", "/actors/Room/r1/Chat", "c2lk"]

        expect(digest).toBe(sha256(text.join("\n")))
      }),
    ))
})
