import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Result, Schedule } from "effect"
import { Fault, Faults } from "../../../../packages/akter/src/store/faults.ts"
import { Condition } from "../../../../packages/akter/src/store/bucket.ts"
import { RETENTION_KEY } from "../../../../packages/akter/src/store/keys.ts"
import { CorruptSegment, StorageUnavailable } from "../../../../packages/akter/src/store/errors.ts"
import {
  RetentionConflict,
  RetentionRefused,
} from "../../../../packages/akter/src/store/retention.ts"
import { storeOf } from "../../../../packages/akter/src/store/service.ts"
import type { StoreBackend } from "./store.ts"

const DAY = 86_400_000
const options = {
  grant: {
    operator: "retention-operator",
    capabilities: [{ action: "retention.set" as const, tenant: "*" }],
  },
  reason: "plan changed",
}

/** The mutable retention record uses real conditional writes on every supported test backend. */
export const retentionConformance = <OE, CE>(backend: StoreBackend<OE, CE>) =>
  describe(`Retention on ${backend.name}`, () => {
    it.effect(
      "admits exactly one concurrent update at the absent and matched record, with a typed loser (rejects plain PUT and rebasing a lost CAS)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const stores = yield* Effect.forEach(["a", "b"], (writer) =>
            Effect.gen(function* () {
              const faults = Faults.plan()
              const store = yield* storeOf(yield* client, {
                writer,
                shards: 1,
                retry: Schedule.recurs(4),
                faults,
              })
              return { store, faults }
            }),
          )
          for (let round = 0; round < 4; round++) {
            const held = yield* Effect.forEach(stores, ({ faults }) =>
              faults.inject(Fault.Hold(), {
                match: ({ kind, key }) => kind === "lease.write" && key === RETENTION_KEY,
              }),
            )
            const changing = yield* Effect.forEach(stores, ({ store }, index) =>
              Effect.forkChild(
                Effect.result(store.setRetention(`${11 + round * 3 + index} days`, options)),
              ),
            )
            yield* Effect.forEach(held, (hold) => hold.fired)
            yield* Effect.forEach(held, (hold) => hold.release)
            const results = yield* Effect.forEach(changing, Fiber.join)
            expect(results.filter(Result.isSuccess)).toHaveLength(1)
            expect(results.filter(Result.isFailure)).toHaveLength(1)
            const winner = results.findIndex(Result.isSuccess)
            for (const result of results)
              if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RetentionConflict)
            for (const { store } of stores)
              expect(yield* store.retention).toBe((11 + round * 3 + winner) * DAY)
            const successful = (yield* stores[0]!.store.audits).filter(
              (audit) => audit.outcome === "allowed",
            )
            expect(successful).toHaveLength(round + 1)
            expect(
              (yield* stores[0]!.store.audits).filter((audit) => audit.outcome === "refused"),
            ).toHaveLength(round + 1)
          }
          for (const { faults } of stores)
            expect(
              (yield* faults.operations).filter(
                ({ kind, key }) => key === RETENTION_KEY && kind === "put",
              ),
            ).toEqual([])
        }),
      60_000,
    )

    it.effect(
      "seeds only new stores, applies scope and inclusive bounds, and preserves mutation audits through reopen (rejects option-driven mutation or a tenant/actor-scoped store change)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const store = yield* storeOf(yield* client, {
            retention: "7 days",
            shards: 1,
            retry: Schedule.recurs(4),
          })
          const reopen = () =>
            Effect.flatMap(client, (bucket) =>
              storeOf(bucket, { retention: "17 days", retry: Schedule.recurs(4) }),
            )
          expect(yield* (yield* reopen()).retention).toBe(7 * DAY)
          for (const capabilities of [
            [],
            [{ action: "retention.set" as const, tenant: "default" }],
            [{ action: "retention.set" as const, tenant: "*", actorType: "Room" }],
            [{ action: "retention.set" as const, tenant: "*", commandId: "one" }],
          ]) {
            const denied = yield* Effect.flip(
              store.setRetention("30 days", {
                ...options,
                grant: { operator: "restricted", capabilities },
              }),
            )
            expect(denied).toBeInstanceOf(RetentionRefused)
            expect(denied).toMatchObject({ reason: "scope" })
          }
          for (const duration of [DAY - 1, 365 * DAY + 1, Number.POSITIVE_INFINITY]) {
            expect(yield* Effect.flip(store.setRetention(duration, options))).toMatchObject({
              reason: "range",
            })
            expect(yield* store.retention).toBe(7 * DAY)
          }
          const first = yield* store.setRetention("1 day", options)
          expect(first.retentionMillis).toBe(DAY)
          expect((yield* store.audits).some((audit) => audit.id === first.audit.id)).toBe(true)
          const last = yield* store.setRetention("365 days", options)
          expect(last.revision).toBe(2)
          const opened = yield* reopen()
          expect(opened.meta.retentionMillis).toBe(7 * DAY)
          expect(yield* opened.retention).toBe(365 * DAY)
          expect(
            (yield* opened.audits)
              .filter(({ outcome }) => outcome === "allowed")
              .map(({ id }) => id)
              .sort(),
          ).toEqual([first.audit.id, last.audit.id].sort())
        }),
      60_000,
    )

    it.effect(
      "recognizes a lost CAS response and refuses an unavailable audit archive before replacing authority (rejects double updates or a mutation without its audit)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const raw = yield* client
          const faults = Faults.plan()
          const store = yield* storeOf(raw, { shards: 1, retry: Schedule.recurs(2), faults })
          yield* faults.inject(Fault.LoseResponse(), {
            match: ({ kind, key }) => kind === "lease.write" && key === RETENTION_KEY,
          })
          const changed = yield* store.setRetention("30 days", options)
          expect(changed.revision).toBe(1)
          expect(yield* store.retention).toBe(30 * DAY)
          expect((yield* store.audits).filter(({ outcome }) => outcome === "allowed")).toEqual([
            changed.audit,
          ])
          yield* faults.inject(Fault.Unavailable({ status: 503 }), {
            match: ({ kind, key }) => kind === "create" && key.startsWith("audit/"),
            times: Number.POSITIVE_INFINITY,
          })
          expect(yield* Effect.flip(store.setRetention("7 days", options))).toBeInstanceOf(
            StorageUnavailable,
          )
          const opened = yield* storeOf(yield* client, { retry: Schedule.recurs(2) })
          expect(yield* opened.retention).toBe(30 * DAY)
          expect((yield* opened.audits).filter(({ outcome }) => outcome === "allowed")).toEqual([
            changed.audit,
          ])
          yield* raw.leases.write(
            RETENTION_KEY,
            new Uint8Array([1, 2, 3]),
            Condition.Matches({
              etag: Option.getOrThrow(yield* raw.leases.read(RETENTION_KEY)).etag,
            }),
          )
          expect(yield* Effect.flip(opened.retention)).toBeInstanceOf(CorruptSegment)
          expect(yield* Effect.flip(opened.setRetention("7 days", options))).toBeInstanceOf(
            CorruptSegment,
          )
        }),
      60_000,
    )
  })
