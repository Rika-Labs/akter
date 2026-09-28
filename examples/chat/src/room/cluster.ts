import { User } from "@durable-actors/core"
import { ActorTest, type ClusterOptions } from "@durable-actors/core/testing"
import type { Redacted } from "effect"

/** The chat's rooms on three runners sharing one Postgres database, as the exit test runs them. */
export const threeRunners = <ROut, E, R>(
  options: { readonly database: Redacted.Redacted } & Pick<
    ClusterOptions<ROut, E, R>,
    "actors" | "runnerActors" | "executors"
  >,
) =>
  ActorTest.cluster({
    ...options,
    runners: 3,
    shardLockExpiration: "3 seconds",
    as: User.make({ subject: "ada" }),
  })
