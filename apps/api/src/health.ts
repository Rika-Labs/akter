import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "@durable-actors/contracts"

/** Handler of `GET /health`. */
export const HealthLive = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
)
