import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { RunnerAuthority } from "@rikalabs/akter/runtime"
import { Effect, FileSystem } from "effect"
import { localAuthority } from "./cloud.ts"

layer(BunServices.layer)("local runner peer authority", (it) => {
  it.effect(
    "gives every process that starts together on an empty directory the same authority, with its own key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = `${yield* fs.makeTempDirectoryScoped()}/authority`
        const authorities = yield* Effect.all(
          Array.from({ length: 12 }, () => localAuthority(directory)),
          { concurrency: "unbounded" },
        )
        const certificate = authorities[0]!.certificate

        expect(new Set(authorities.map((authority) => authority.certificate)).size).toBe(1)
        for (const authority of authorities)
          yield* RunnerAuthority.from({ certificate, key: authority.key })
        expect((yield* localAuthority(directory)).certificate).toBe(certificate)
        expect((yield* fs.readDirectory(directory)).filter((name) => name.startsWith("."))).toEqual(
          [],
        )
      }).pipe(Effect.scoped),
  )
})
