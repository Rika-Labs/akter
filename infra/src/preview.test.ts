import { afterAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime } from "effect"
import { preview, previewLayer } from "./preview.ts"

const runtime = ManagedRuntime.make(previewLayer)
afterAll(() => runtime.dispose())

describe("credential-free resource graph", () => {
  for (const stage of ["dev", "staging", "prod"] as const) {
    for (const region of ["us-east-1", "us-west-2"] as const) {
      it(`registers all services and their providers in ${stage}/${region}`, () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const graph = yield* preview({ stage, region })
            expect(graph.stage).toBe(stage)
            expect(graph.name).toBe(`akter-${region}`)
            for (const name of ["api", "edge", "console"]) {
              expect(graph.resources).toContainEqual({
                id: `${name}/Task`,
                type: "AWS.ECS.TaskDefinition",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Service`,
                type: "AWS.ECS.Service",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Target`,
                type: "AWS.ELBv2.TargetGroup",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Listener`,
                type: "AWS.ELBv2.Listener",
              })
            }
            expect(graph.resources).toContainEqual({
              id: "CustomerEnvironmentKey",
              type: "AWS.KMS.Key",
            })
            expect(graph.resources).toContainEqual({
              id: "EmailIdentity",
              type: "AWS.SES.EmailIdentity",
            })
            expect(graph.resources).toContainEqual({ id: "ServiceErrors", type: "Axiom.Monitor" })
            expect(graph.resources).toContainEqual({
              id: "Database",
              type: "Planetscale.NekiDatabase",
            })
            expect(graph.resources).toContainEqual({
              id: "RuntimeRole",
              type: "Planetscale.NekiRole",
            })
            expect(graph.resources).toContainEqual({
              id: "CustomerHosts/app.customer.example",
              type: "Cloudflare.CustomHostname.CustomHostname",
            })
          }),
        ))
    }
  }
})
