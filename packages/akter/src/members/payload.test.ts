import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Actor } from "../index.ts"
import { payloadChain, payloadCodec } from "./payload.ts"

const renamed = Actor.migration(
  { name: Schema.String },
  { title: Schema.String },
  ({ name }) => ({ title: name }),
  { downcast: ({ title }) => ({ name: title }) },
)

describe("direct event and job values", () => {
  it("keep class construction and decode stored payloads through their own chains", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const Titled = Actor.event("Titled", { title: Schema.String }, { migrations: [renamed] })

        const Rolling = Actor.job("Rolling", {
          payload: { title: Schema.String },
          migrations: [renamed],
          writeVersion: 0,
        })

        const event = Titled.make({ title: "a" })

        expect(event).toBeInstanceOf(Titled)
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Titled))(event)).toBe(
          '{"_tag":"Titled","title":"a"}',
        )
        expect(payloadChain(Titled)).toMatchObject({ first: 0, current: 1, writeVersion: 1 })
        expect(payloadChain(Rolling)).toMatchObject({ current: 1, writeVersion: 0 })

        const events = payloadCodec({ schema: Titled, tag: Titled.identifier })
        const old = yield* events.decode('{"_tag":"Titled","name":"b"}', 0)
        expect(old).toBeInstanceOf(Titled)
        expect(old).toEqual(Titled.make({ title: "b" }))

        const jobs = payloadCodec({ schema: Rolling, tag: Rolling.tag })
        const written = yield* jobs.encode(Rolling.make({ title: "c" }))
        expect(written.version).toBe(0)
        expect(written.value).toBe('{"_tag":"Rolling","name":"c"}')
        expect(yield* jobs.decode(written.value, written.version)).toEqual(
          Rolling.make({ title: "c" }),
        )
      }),
    ))

  it("reject an invalid chain when the value is built", () => {
    expect(() =>
      Actor.event("Broken", { other: Schema.String }, { migrations: [renamed] }),
    ).toThrow("last migration must produce its declared fields")
    expect(() =>
      Actor.job("Unwritable", {
        payload: { title: Schema.String },
        migrations: [
          Actor.migration({ name: Schema.String }, { title: Schema.String }, ({ name }) => ({
            title: name,
          })),
        ],
        writeVersion: 0,
      }),
    ).toThrow("needs a downcast")
  })
})
