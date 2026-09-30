import { Effect, Stream } from "effect"
import type { WatchResult } from "../../runtime/members.ts"
import { failureJson, message, type SessionFailure, valueJson, withKeepalive } from "./sse.ts"

/**
 * A watch as SSE text: each result as `event: result` with the encoded output
 * as `data`, and as `id` the commit version its rerun waited for when there was
 * one. A watch is state, not history, so there is no `Last-Event-ID` resume: a
 * reconnect opens a new watch whose first result is the current state. The last
 * message is `end`, carrying the `ActorError` envelope or the query's declared
 * error that ended it.
 */
export const watchResponse = (results: Stream.Stream<WatchResult, SessionFailure>) =>
  results.pipe(
    Stream.mapEffect(({ version, value }) =>
      valueJson(value).pipe(
        Effect.flatMap((json) => message({ event: "result", data: json, id: version })),
      ),
    ),
    Stream.catch((error) =>
      Stream.fromEffect(
        failureJson(error).pipe(Effect.flatMap((body) => message({ event: "end", data: body }))),
      ),
    ),
    withKeepalive,
  )
