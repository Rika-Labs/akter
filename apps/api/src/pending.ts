import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { CloudApi, NotImplemented } from "@akter/cloud-api"

const notImplemented = (operation: string) => Effect.fail(NotImplemented.make({ operation }))

export const EnvironmentVariablesNotImplemented = HttpApiBuilder.group(
  CloudApi,
  "environmentVariables",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle("list", () => notImplemented("environmentVariables.list"))
        .handle("set", () => notImplemented("environmentVariables.set"))
        .handle("delete", () => notImplemented("environmentVariables.delete"))
        .handle("import", () => notImplemented("environmentVariables.import")),
    ),
)

export const DomainsNotImplemented = HttpApiBuilder.group(CloudApi, "domains", (handlers) =>
  Effect.succeed(
    handlers
      .handle("list", () => notImplemented("domains.list"))
      .handle("add", () => notImplemented("domains.add"))
      .handle("verify", () => notImplemented("domains.verify"))
      .handle("remove", () => notImplemented("domains.remove")),
  ),
)

export const RegionsNotImplemented = HttpApiBuilder.group(CloudApi, "regions", (handlers) =>
  Effect.succeed(
    handlers
      .handle("catalog", () => notImplemented("regions.catalog"))
      .handle("list", () => notImplemented("regions.list"))
      .handle("add", () => notImplemented("regions.add"))
      .handle("remove", () => notImplemented("regions.remove"))
      .handle("setHome", () => notImplemented("regions.setHome")),
  ),
)

export const IntegrationsNotImplemented = HttpApiBuilder.group(
  CloudApi,
  "integrations",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle("list", () => notImplemented("integrations.list"))
        .handle("connect", () => notImplemented("integrations.connect"))
        .handle("disconnect", () => notImplemented("integrations.disconnect")),
    ),
)

export const PendingLayers = Layer.mergeAll(
  EnvironmentVariablesNotImplemented,
  DomainsNotImplemented,
  RegionsNotImplemented,
  IntegrationsNotImplemented,
)
