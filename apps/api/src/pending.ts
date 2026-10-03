import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { CloudApi, NotImplemented } from "@akter/cloud-api"
import { Access } from "./access.ts"

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

export const DeploymentsNotImplemented = HttpApiBuilder.group(CloudApi, "deployments", (handlers) =>
  Effect.succeed(
    handlers
      .handle("list", () => notImplemented("deployments.list"))
      .handle("create", () => notImplemented("deployments.create"))
      .handle("get", () => notImplemented("deployments.get"))
      .handle("getBuildLog", () => notImplemented("deployments.getBuildLog"))
      .handle("rollback", () => notImplemented("deployments.rollback"))
      .handle("redeploy", () => notImplemented("deployments.redeploy")),
  ),
)

export const RuntimeNotImplemented = HttpApiBuilder.group(CloudApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    return handlers
      .handle("getOverview", () => notImplemented("runtime.getOverview"))
      .handle("getSidebarCounts", () => notImplemented("runtime.getSidebarCounts"))
      .handle("search", () => notImplemented("runtime.search"))
      .handle("listActorTypes", () => notImplemented("runtime.listActorTypes"))
      .handle("getActorType", () => notImplemented("runtime.getActorType"))
      .handle("getActorTypeActivity", ({ params }) =>
        access
          .project(params.projectId)
          .pipe(Effect.andThen(notImplemented("runtime.getActorTypeActivity"))),
      )
      .handle("getActorTypeLatency", ({ params }) =>
        access
          .project(params.projectId)
          .pipe(Effect.andThen(notImplemented("runtime.getActorTypeLatency"))),
      )
      .handle("listActorInstances", () => notImplemented("runtime.listActorInstances"))
      .handle("inspectActor", () => notImplemented("runtime.inspectActor"))
      .handle("listActorTables", () => notImplemented("runtime.listActorTables"))
      .handle("listActorReceipts", () => notImplemented("runtime.listActorReceipts"))
      .handle("listActorEvents", () => notImplemented("runtime.listActorEvents"))
      .handle("listActorJobs", () => notImplemented("runtime.listActorJobs"))
      .handle("listActorTimeline", () => notImplemented("runtime.listActorTimeline"))
      .handle("listCommands", () => notImplemented("runtime.listCommands"))
      .handle("streamCommands", () => notImplemented("runtime.streamCommands"))
      .handle("getJobs", () => notImplemented("runtime.getJobs"))
      .handle("listDeadLetters", () => notImplemented("runtime.listDeadLetters"))
      .handle("retryDeadLetter", () => notImplemented("runtime.retryDeadLetter"))
      .handle("discardDeadLetter", () => notImplemented("runtime.discardDeadLetter"))
      .handle("listWorkflows", () => notImplemented("runtime.listWorkflows"))
      .handle("getTimers", () => notImplemented("runtime.getTimers"))
      .handle("listSchedules", () => notImplemented("runtime.listSchedules"))
      .handle("getConnections", () => notImplemented("runtime.getConnections"))
      .handle("sendCommand", ({ params }) =>
        access
          .project(params.projectId, "write")
          .pipe(Effect.andThen(notImplemented("runtime.sendCommand"))),
      )
  }),
)

export const PendingLayers = Layer.mergeAll(
  EnvironmentVariablesNotImplemented,
  DomainsNotImplemented,
  RegionsNotImplemented,
  IntegrationsNotImplemented,
  DeploymentsNotImplemented,
  RuntimeNotImplemented,
)
