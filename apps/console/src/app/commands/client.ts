import { type CommandLogEntry, SendCommand } from "@akter/cloud-api"
import { Effect, Schema, Stream } from "effect"
import {
  cloud,
  ConsoleError,
  consoleError,
  fixturesEnabled,
  type Loaded,
  projectContext,
  withProject,
} from "../api/client.ts"
import { tailCapacity, toRecentTurns, toRejected, toSucceeded } from "./mapping.ts"
import { type CommandAnswer, type CommandScope, CommandsPage } from "./model.ts"

/** Loads the actor types the filter offers and the turns committed just before the page opened. */
export const loadCommands: Effect.Effect<Loaded<CommandsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const params = { projectId: project.id, environment }
      const types = yield* api.runtime.listActorTypes({ params })
      const recent = yield* api.runtime.listCommands({ params, query: { limit: tailCapacity } })
      return CommandsPage.make({
        types: types.map((type) => type.name),
        recent: toRecentTurns(recent.items),
      })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.commandsPage),
)

const sampleOnly = ConsoleError.make({ kind: "Sample", message: "Sample data is read-only." })

/** What the console sends: payload is the JSON text the operator typed; no id lets the server mint one. */
export interface SendRequest {
  readonly scope: CommandScope
  readonly address: string
  readonly command: string
  readonly payload: string
  readonly commandId?: string
}

const parsePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
const encodeRequest = Schema.decodeUnknownEffect(SendCommand)

/**
 * Sends one command to one actor. Sample data never sends, and `NotImplemented` fails rather than
 * pretending the command ran. An error the actor returns is a `CommandRejected` answer; transport,
 * authorization and conflict failures are `ConsoleError`. The supplied scope is the one captured
 * from the actor page; a changed project selection never retargets the command.
 */
export const sendCommand = (request: SendRequest): Effect.Effect<CommandAnswer, ConsoleError> =>
  Effect.suspend(() => {
    if (fixturesEnabled()) return Effect.fail(sampleOnly)
    return Effect.gen(function* () {
      const payload = yield* parsePayload(request.payload).pipe(
        Effect.mapError(() =>
          ConsoleError.make({ kind: "InvalidPayload", message: "The payload isn’t valid JSON." }),
        ),
      )
      const draft = { address: request.address, command: request.command, payload }
      const body = yield* encodeRequest(
        request.commandId === undefined ? draft : { ...draft, commandId: request.commandId },
      ).pipe(
        Effect.mapError(() =>
          ConsoleError.make({
            kind: "InvalidCommand",
            message: "Check the actor address and command name.",
          }),
        ),
      )
      const api = yield* cloud
      return yield* api.runtime.sendCommand({ params: request.scope, payload: body }).pipe(
        Effect.map(toSucceeded),
        Effect.catchTag("CommandFailed", (failed) => Effect.succeed(toRejected(failed))),
        Effect.mapError(consoleError),
      )
    })
  })

/**
 * Opens the live command stream and succeeds once the response headers have arrived, so a caller
 * can tell "connected" from "waiting for the first event". The stream is unfiltered; the caller
 * filters locally so changing the filter never reconnects. Sample data never connects.
 */
export const openTurns: Effect.Effect<
  Stream.Stream<CommandLogEntry, ConsoleError>,
  ConsoleError
> = Effect.suspend(() => {
  if (fixturesEnabled()) return Effect.fail(sampleOnly)
  return Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
    const turns = yield* api.runtime
      .streamCommands({ params: { projectId: project.id, environment }, query: {} })
      .pipe(Effect.mapError(consoleError))
    return turns.pipe(Stream.mapError(consoleError))
  })
})

/** The committed turns as they happen, decoded to UTC instants; it fails like `openTurns`. */
export const streamTurns: Stream.Stream<CommandLogEntry, ConsoleError> = Stream.unwrap(openTurns)
