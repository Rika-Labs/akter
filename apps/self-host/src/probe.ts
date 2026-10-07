import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

await Effect.runPromise(
  HttpClient.get(`http://127.0.0.1:8080/${process.argv[2] ?? "ready"}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.die(new Error(`Probe returned ${response.status}`)),
    ),
    Effect.timeout("2 seconds"),
    Effect.provide(FetchHttpClient.layer),
  ),
)
