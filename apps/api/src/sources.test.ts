import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { createDatabase } from "./fixtures.ts"
import { SourceNotFound, Sources, SourcesLive } from "./sources.ts"

const database = Layer.unwrap(
  createDatabase("api_sources").pipe(
    Effect.map((url) => PgClient.layer({ url, maxConnections: 4 })),
  ),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const bytes = (text: string) => new TextEncoder().encode(text)

const sha256 = (data: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(data).digest("hex")}`

layer(SourcesLive({ builds: true }).pipe(Layer.provideMerge(database)), {
  excludeTestServices: true,
})("uploaded build contexts over real Postgres", (it) => {
  it.effect(
    "names an archive by the SHA-256 of its bytes, stores it once, and builds each deployment from exactly the archive it attached",
    () =>
      Effect.gen(function* () {
        const sources = yield* Sources
        const first = bytes("first context \u0000 with a NUL byte")
        const second = bytes("second, longer context")

        const stored = yield* sources.store({
          organizationId: "org_a",
          projectId: "prj_a",
          archive: first,
        })

        expect(stored).toEqual({ digest: sha256(first), sizeBytes: first.byteLength })
        expect(
          yield* sources.store({ organizationId: "org_a", projectId: "prj_a", archive: first }),
        ).toEqual(stored)

        const other = yield* sources.store({
          organizationId: "org_a",
          projectId: "prj_a",
          archive: second,
        })

        expect(other.digest).toBe(sha256(second))

        yield* sources.attach({
          organizationId: "org_a",
          projectId: "prj_a",
          deploymentId: "dep_first",
          digest: stored.digest,
          dockerfile: "infra/runner/Dockerfile",
        })
        yield* sources.attach({
          organizationId: "org_a",
          projectId: "prj_a",
          deploymentId: "dep_second",
          digest: other.digest,
          dockerfile: "Dockerfile",
        })

        const built = Option.getOrThrow(yield* sources.forDeployment("dep_first"))

        expect(Array.from(built.archive)).toEqual(Array.from(first))
        expect(built.dockerfile).toBe("infra/runner/Dockerfile")
        expect(Option.getOrThrow(yield* sources.forDeployment("dep_second")).dockerfile).toBe(
          "Dockerfile",
        )

        yield* sources.copy({ from: "dep_first", to: "dep_redeploy" })
        const redeployed = Option.getOrThrow(yield* sources.forDeployment("dep_redeploy"))

        expect(Array.from(redeployed.archive)).toEqual(Array.from(first))
        expect(redeployed.dockerfile).toBe("infra/runner/Dockerfile")

        yield* sources.copy({ from: "dep_without_source", to: "dep_plain_redeploy" })
        expect(Option.isNone(yield* sources.forDeployment("dep_plain_redeploy"))).toBe(true)
        expect(Option.isNone(yield* sources.forDeployment("dep_unknown"))).toBe(true)
      }),
  )

  it.effect(
    "refuses to attach an archive the project was never sent, even one another project or organization holds",
    () =>
      Effect.gen(function* () {
        const sources = yield* Sources
        const archive = bytes("project b context")
        const { digest } = yield* sources.store({
          organizationId: "org_b",
          projectId: "prj_b",
          archive,
        })

        for (const target of [
          { organizationId: "org_b", projectId: "prj_c" },
          { organizationId: "org_c", projectId: "prj_b" },
        ]) {
          const refused = yield* sources
            .attach({ ...target, deploymentId: "dep_stolen", digest, dockerfile: "Dockerfile" })
            .pipe(Effect.flip)

          expect(refused).toEqual(SourceNotFound.make({ digest }))
        }

        const unknown = sha256(bytes("never uploaded"))

        expect(
          yield* sources
            .attach({
              organizationId: "org_b",
              projectId: "prj_b",
              deploymentId: "dep_unknown_source",
              digest: unknown,
              dockerfile: "Dockerfile",
            })
            .pipe(Effect.flip),
        ).toEqual(SourceNotFound.make({ digest: unknown }))
        expect(Option.isNone(yield* sources.forDeployment("dep_stolen"))).toBe(true)
        expect(Option.isNone(yield* sources.forDeployment("dep_unknown_source"))).toBe(true)
      }),
  )
})
