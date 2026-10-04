import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem } from "effect"
import {
  configDirectory,
  CredentialsExposed,
  CredentialsUnreadable,
  loadCredentials,
  NotLoggedIn,
  removeCredentials,
  saveCredentials,
} from "./credentials.ts"

/** A fresh directory inside a temporary one, removed with the scope, named by `AKTER_CONFIG_DIR` for `effect`. */
const inConfigDirectory = <A, E>(
  effect: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = `${yield* fs.makeTempDirectoryScoped()}/nested/akter`

    return yield* effect(directory).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { AKTER_CONFIG_DIR: directory } }),
      ),
    )
  })

const credentials = { apiUrl: "http://127.0.0.1:4100", token: "tok-asymmetric", email: "a@b.dev" }

const modeOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)).pipe(
    Effect.map((info) => info.mode & 0o777),
  )

const posix = process.platform !== "win32"

layer(BunServices.layer)("credential storage", (it) => {
  it("lives in each operating system's own configuration directory unless AKTER_CONFIG_DIR names one", () => {
    expect(configDirectory({ platform: "darwin", home: "/Users/ada" })).toBe(
      "/Users/ada/Library/Application Support/akter",
    )
    expect(configDirectory({ platform: "linux", home: "/home/ada" })).toBe(
      "/home/ada/.config/akter",
    )
    expect(
      configDirectory({ platform: "linux", home: "/home/ada", xdgConfigHome: "/xdg/config" }),
    ).toBe("/xdg/config/akter")
    expect(configDirectory({ platform: "linux", home: "/home/ada", xdgConfigHome: "" })).toBe(
      "/home/ada/.config/akter",
    )
    expect(
      configDirectory({
        platform: "win32",
        home: "C:\\Users\\ada",
        appData: "D:\\Profiles\\ada\\Roaming",
      }),
    ).toBe("D:\\Profiles\\ada\\Roaming\\akter")
    expect(configDirectory({ platform: "win32", home: "C:\\Users\\ada" })).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\akter",
    )
    expect(
      configDirectory({ platform: "darwin", home: "/Users/ada", override: "/srv/akter-ci" }),
    ).toBe("/srv/akter-ci")
  })

  it.effect.skipIf(!posix)(
    "writes the file 0600 in a 0700 directory, and tightens an older file and directory other users could read",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* saveCredentials(credentials)

          expect(file).toBe(`${directory}/credentials.json`)
          expect(yield* modeOf(file)).toBe(0o600)
          expect(yield* modeOf(directory)).toBe(0o700)
          expect(yield* loadCredentials).toEqual(credentials)

          yield* fs.chmod(file, 0o644)
          yield* fs.chmod(directory, 0o755)

          const replaced = { ...credentials, token: "tok-second", email: "c@d.dev" }

          yield* saveCredentials(replaced)

          expect(yield* modeOf(file)).toBe(0o600)
          expect(yield* modeOf(directory)).toBe(0o700)
          expect(yield* loadCredentials).toEqual(replaced)
          expect((yield* fs.readDirectory(directory)).toSorted()).toEqual(["credentials.json"])
        }),
      ),
  )

  it.effect.skipIf(!posix)(
    "refuses a credentials file group or others can read or write, and one it did not write",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* saveCredentials(credentials)

          for (const mode of [0o640, 0o604, 0o620, 0o602]) {
            yield* fs.chmod(file, mode)
            expect(yield* Effect.flip(loadCredentials)).toEqual(
              CredentialsExposed.make({ path: file, mode }),
            )
          }

          yield* fs.chmod(file, 0o400)
          expect(yield* loadCredentials).toEqual(credentials)

          yield* fs.chmod(file, 0o600)
          yield* fs.writeFileString(file, '{"apiUrl":"http://x"}')
          expect(yield* Effect.flip(loadCredentials)).toEqual(
            CredentialsUnreadable.make({ path: `${directory}/credentials.json` }),
          )
        }),
      ),
  )

  it.effect(
    "reports no credentials before login and after removal, and removal is idempotent",
    () =>
      inConfigDirectory((directory) =>
        Effect.gen(function* () {
          const missing = NotLoggedIn.make({ path: `${directory}/credentials.json` })

          expect(yield* Effect.flip(loadCredentials)).toEqual(missing)
          expect(yield* removeCredentials).toBe(false)

          yield* saveCredentials(credentials)

          expect(yield* removeCredentials).toBe(true)
          expect(yield* Effect.flip(loadCredentials)).toEqual(missing)
          expect(yield* removeCredentials).toBe(false)
        }),
      ),
  )
})
