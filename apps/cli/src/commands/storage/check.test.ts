import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Fault, Faults, StorageUnavailable, Store } from "@rikalabs/akter/server"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { runCliWith } from "../../testing.ts"
import { StorageCheck } from "./check.ts"

const quick = ["--writers", "4", "--rounds", "3", "--writes", "3", "--settle-ms", "20"]

const probeNames = [
  "conditional create race",
  "compare-and-swap race",
  "list after write",
  "ordered listing with limit and start-after",
  "overwrite refreshes last-modified",
  "per-key write rate",
  "batch delete",
]

const Report = Schema.Struct({
  cli: Schema.String,
  checkedAt: Schema.String,
  target: Schema.Struct({ kind: Schema.String, directory: Schema.String }),
  passed: Schema.Boolean,
  probes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      passed: Schema.Boolean,
      detail: Schema.String,
      measured: Schema.Record(Schema.String, Schema.Finite),
    }),
  ),
})

const decodeReport = Schema.decodeEffect(Schema.fromJsonString(Report))

const run = runCliWith({ env: {} })

describe("akter storage check", () => {
  it.live(
    "checks a local directory: every probe passes with its numbers, exit 0, and nothing is written outside check/ (rejects a check that opens a store in the target)",
    () =>
      Effect.gen(function* () {
        const fs = Context.get(yield* Layer.build(BunServices.layer), FileSystem.FileSystem)
        const directory = yield* fs.makeTempDirectoryScoped()

        const text = yield* run(["storage", "check", "--directory", directory, ...quick])

        expect(text.exitCode).toBe(0)
        expect(text.stderr).toBe("")
        expect(text.stdout).toContain(`Target: directory ${directory}`)
        for (const name of probeNames)
          expect(text.stdout).toMatch(new RegExp(`^PASS  ${name} \\(\\d+ ms\\)$`, "m"))
        expect(text.stdout).toContain(
          "4 writers x 3 rounds: 0 rounds with two successful creators, 0 winners not stored, 0 unanswered writes",
        )
        expect(text.stdout).toContain("Passed: all 7 probes.")
        expect(text.stdout).not.toContain("FAIL")

        const written = yield* fs.readDirectory(directory, { recursive: true })
        expect(written.filter((path) => path !== "check" && !path.startsWith("check/"))).toEqual([])

        const machine = yield* run([
          "storage",
          "check",
          "--directory",
          directory,
          "--json",
          ...quick,
        ])
        const report = yield* decodeReport(machine.stdout)

        expect(machine.exitCode).toBe(0)
        expect(machine.stderr).toBe("")
        expect(report.passed).toBe(true)
        expect(report.target).toEqual({ kind: "fileSystem", directory })
        expect(report.probes.map((probe) => probe.name)).toEqual(probeNames)
        expect(report.probes.every((probe) => probe.passed)).toBe(true)
        const modified = report.probes.find(
          (probe) => probe.name === "overwrite refreshes last-modified",
        )
        expect(modified?.measured.settleMillis).toBe(20)
        expect(modified?.measured.advancedMillis).toBeGreaterThan(0)
        expect(report.probes[0]?.measured).toMatchObject({
          writers: 4,
          rounds: 3,
          doubleWinners: 0,
        })
        expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false)
      }),
  )

  it.live(
    "exits 1 and names the failing property when a probe fails, in text and in JSON (rejects an exit status that ignores the report)",
    () =>
      Effect.gen(function* () {
        const faults = Faults.plan()
        yield* faults.inject(Fault.Unavailable({ status: 500 }), {
          match: (operation) => operation.kind === "lease.write" && operation.key.endsWith("/rate"),
          times: Number.POSITIVE_INFINITY,
        })
        const failing = runCliWith({ env: {} })
        const provide = Effect.provideService(StorageCheck, (_target, options) =>
          Effect.scoped(
            Effect.flatMap(Layer.build(Store.memory({ faults })), (context) =>
              Store.check(options).pipe(Effect.provideContext(context)),
            ),
          ).pipe(Effect.orDie),
        )

        const text = yield* failing(["storage", "check", "--directory", "unused", ...quick]).pipe(
          provide,
        )

        expect(text.exitCode).toBe(1)
        expect(text.reason).toBe("ProbeFailed")
        expect(text.stdout).toMatch(/^FAIL  per-key write rate \(\d+ ms\)$/m)
        expect(text.stdout).toContain("3 back-to-back writes to one key")
        expect(text.stdout).toContain("3 failed otherwise")
        for (const name of probeNames.filter((name) => name !== "per-key write rate"))
          expect(text.stdout).toMatch(new RegExp(`^PASS  ${name} `, "m"))
        expect(text.stdout).toContain("Failed: per-key write rate.")

        const machine = yield* failing([
          "storage",
          "check",
          "--directory",
          "unused",
          "--json",
          ...quick,
        ]).pipe(provide)
        const report = yield* decodeReport(machine.stdout)

        expect(machine.exitCode).toBe(1)
        expect(report.passed).toBe(false)
        expect(report.probes.filter((probe) => !probe.passed).map((probe) => probe.name)).toEqual([
          "per-key write rate",
        ])
      }),
  )

  it.live(
    "refuses a target it cannot use with exit 2 and prints no credential (rejects echoing the endpoint or the secret back)",
    () =>
      Effect.gen(function* () {
        const secret = "synthetic-secret-access-key"
        const token = "synthetic-session-token"
        for (const [args, env, message] of [
          [["storage", "check"], {}, "Name the bucket with --bucket or AKTER_STORAGE_BUCKET"],
          [
            ["storage", "check", "--bucket", "b", "--directory", "d"],
            {},
            "Name either --bucket or --directory, not both.",
          ],
          [
            [
              "storage",
              "check",
              "--bucket",
              "b",
              "--endpoint",
              `https://user:${secret}@store.test`,
            ],
            {},
            "The endpoint must not carry credentials",
          ],
          [
            ["storage", "check", "--bucket", "b"],
            { AKTER_STORAGE_ACCESS_KEY_ID: "id", AWS_SESSION_TOKEN: token },
            "Set both the access key id and the secret access key",
          ],
          [
            ["storage", "check", "--bucket", "b"],
            { AKTER_STORAGE_SECRET_ACCESS_KEY: secret },
            "Set both the access key id and the secret access key",
          ],
        ] as const) {
          const refused = yield* runCliWith({ env })(args)

          expect(refused.exitCode).toBe(2)
          expect(refused.reason).toBe("UsageError")
          expect(refused.stderr).toContain(message)
          expect(refused.stdout + refused.stderr).not.toContain(secret)
          expect(refused.stdout + refused.stderr).not.toContain(token)
        }

        const zero = yield* run(["storage", "check", "--directory", "d", "--writers", "0"])

        expect(zero.exitCode).toBe(2)
        expect(zero.reason).toBe("InvalidValue")
      }),
  )

  it.live(
    "reports an unreachable bucket as exit 2 with the credential scrubbed from the message",
    () =>
      Effect.gen(function* () {
        const secret = "synthetic-secret-access-key"
        const unreachable = yield* runCliWith({
          env: {
            AKTER_STORAGE_BUCKET: "b",
            AKTER_STORAGE_ACCESS_KEY_ID: "id",
            AKTER_STORAGE_SECRET_ACCESS_KEY: secret,
          },
        })(["storage", "check", "--endpoint", "http://127.0.0.1:1"]).pipe(
          Effect.provideService(StorageCheck, () =>
            StorageUnavailable.make({
              operation: "get",
              key: "check/x",
              status: 403,
              reason: `signature mismatch for ${secret}`,
            }),
          ),
        )

        expect(unreachable.exitCode).toBe(2)
        expect(unreachable.stderr).toContain(
          "The storage check could not run: get check/x (HTTP 403): signature mismatch for [redacted]",
        )
        expect(unreachable.stdout + unreachable.stderr).not.toContain(secret)
        expect(unreachable.stdout).not.toMatch(/PASS|FAIL/)
      }),
  )
})
