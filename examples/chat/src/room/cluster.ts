import { User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import type { Layer, Redacted } from "effect"

/** The chat's rooms on three runners sharing one Postgres database, as the exit test runs them. */
export const threeRunners = <ROut, E, R>(options: {
  readonly database: Redacted.Redacted
  readonly actors: Layer.Layer<ROut, E, R>
}) =>
  ActorTest.cluster({
    database: options.database,
    runners: 3,
    shardLockExpiration: "3 seconds",
    actors: options.actors,
    as: User.make({ subject: "ada" }),
  })
