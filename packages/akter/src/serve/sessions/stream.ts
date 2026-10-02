import { Effect, Stream } from "effect"
import { failureJson, message, type SessionFailure, valueJson, withKeepalive } from "./sse.ts"

/**
 * A subscription as SSE text: each element as `event: element` with its
 * encoded value as `data`, then one `end` message: `null` when the stream
 * ended by itself, else the `ActorError` envelope or the member's declared
 * error that ended it. Streams have no cursor, so there is no `id`.
 */
export const streamResponse = (elements: Stream.Stream<string, SessionFailure>) =>
  elements.pipe(
    Stream.mapEffect((element) =>
      valueJson(element).pipe(Effect.flatMap((json) => message({ event: "element", data: json }))),
    ),
    Stream.concat(Stream.fromEffect(message({ event: "end", data: null }))),
    Stream.catch((error) =>
      Stream.fromEffect(
        failureJson(error).pipe(Effect.flatMap((body) => message({ event: "end", data: body }))),
      ),
    ),
    withKeepalive,
  )
