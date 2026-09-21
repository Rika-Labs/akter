import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@durable-actors/contracts"

export const HealthLive = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
)
