import { ActorTest } from "@durable-actors/core/testing"
import { Effect } from "effect"
import { Room, RoomId } from "./contract.ts"

/**
 * The chat script under `ActorTest.simulate`: posts, reactions, and reply
 * threads in one room, each command under a fault drawn from the seed. It
 * returns what the script committed, for the caller to check the room against.
 */
export const chatScript = (seed: string) =>
  Effect.gen(function* () {
    const posted: Array<string> = []
    const threads: Array<string> = []
    let reactions = 0

    const report = yield* ActorTest.simulate(
      {
        seed,
        faults: ["crashBeforeCommit", "crashAfterCommit", "dropReply", "relayCrash", "clockSkew"],
      },
      (sim) =>
        Effect.gen(function* () {
          const room = yield* Room.get(RoomId.make(`sim-${seed}`))

          for (let step = 0; step < 10; step++) {
            const kind = yield* sim.pick(["post", "post", "react", "thread"])

            if (kind === "post") {
              posted.push(
                yield* sim.command(`post ${step}`, room.Post({ body: `message ${step}` })),
              )
            } else if (kind === "react") {
              const amount = yield* sim.int(1, 3)
              yield* sim.command(`react ${step}`, room.React(amount))
              reactions += amount
            } else if (posted.length > 0) {
              const messageId = posted[yield* sim.int(0, posted.length - 1)]!

              threads.push(
                yield* sim.command(`thread ${step}`, room.StartThread({ messageId }), {
                  relays: true,
                }),
              )
            }
          }
        }),
    )

    return { report, posted, threads, reactions }
  })
