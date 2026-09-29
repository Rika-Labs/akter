import { publishedKeys } from "@durable-actors/deployments"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

/**
 * The hosted edge's published verification keys, which every hosted runner
 * polls through `Actor.auth.assertion({ keys: <this URL> })`. Public keys
 * only, so the route needs no credential.
 */
export const edgeKeysRoute = HttpRouter.add(
  "GET",
  "/edge/keys",
  publishedKeys.pipe(
    Effect.flatMap((keys) =>
      HttpServerResponse.json(keys, { headers: { "cache-control": "no-store" } }),
    ),
    Effect.orDie,
  ),
)
