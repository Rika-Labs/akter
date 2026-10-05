import { credentials } from "@distilled.cloud/fly-io/Credentials"
import { Retry } from "@distilled.cloud/fly-io/Retry"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

/** The token every request must carry; tests assert it never reaches an error. */
export const FLY_TOKEN = "fly-test-token-only"

/** One request the fake received, as Distilled sent it. */
export interface FlyCall {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly authorization: string
  readonly body: Schema.Json | undefined
}

export interface FlyReply {
  readonly status?: number
  readonly body: Schema.Json
}

const FlyEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  status: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Finite),
  request: Schema.optional(
    Schema.Struct({
      exit_event: Schema.optional(
        Schema.Struct({
          requested_stop: Schema.optional(Schema.Boolean),
          exit_code: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
})

type FlyEvent = typeof FlyEvent.Type

export interface FlyMachine {
  id: string
  name: string
  region: string
  state: string
  config: Record<string, Schema.Json>
  events: Array<FlyEvent>
  stopping: number
}

export interface FlyApp {
  readonly name: string
  readonly organization: string
  readonly network: string
  readonly key: string | undefined
  readonly addresses: Array<{ readonly ip: string; readonly shared: boolean }>
  readonly machines: Array<FlyMachine>
}

/**
 * What a test scripts on top of the fake's own behavior. `noCapacity` lists
 * Fly regions that refuse a new machine the way Fly does when it is full,
 * with the HTTP status `capacityStatus`. `staleList` makes the first machine
 * list empty even when machines exist, as a list read just before another
 * caller's create would be. `createdAs` creates every machine already in
 * that state, with an exit event when `exit` is given, as a one-shot process
 * that finished before anyone read it would be. `override` answers a call
 * itself and wins over everything else.
 */
export interface FlyScript {
  readonly organization?: string
  readonly noCapacity?: ReadonlyArray<string>
  readonly capacityStatus?: 412 | 422
  readonly staleList?: boolean
  readonly createdAs?: { readonly state: string; readonly exit?: { readonly code?: number } }
  readonly override?: (call: FlyCall) => FlyReply | undefined
}

const Body = Schema.Struct({
  name: Schema.optional(Schema.String),
  org_slug: Schema.optional(Schema.String),
  network: Schema.optional(Schema.String),
  idempotency_key: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  config: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})

const decodeBody = Schema.decodeUnknownEffect(Body)
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const CreateBody = Schema.Struct({
  name: Schema.String,
  region: Schema.String,
  config: Schema.Record(Schema.String, Schema.Json),
})

const decodeCreate = Schema.decodeUnknownOption(CreateBody)

/** The machine creates among `calls`, each decoded from the request body Distilled sent. */
export const creates = (calls: ReadonlyArray<FlyCall>) =>
  calls.flatMap((call) =>
    call.method === "POST" && call.path.endsWith("/machines")
      ? Option.toArray(decodeCreate(call.body))
      : [],
  )

const reply = (status: number, body: Schema.Json) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const rendered = (machine: FlyMachine) => ({
  id: machine.id,
  name: machine.name,
  state: machine.state,
  region: machine.region,
  config: machine.config,
  events: machine.events,
  private_ip: "fdaa:0:1::2",
  created_at: "2026-10-05T00:00:00Z",
  updated_at: "2026-10-05T00:00:00Z",
})

const exitEvent = (code: number | undefined, timestamp: number): FlyEvent => {
  const event = {
    id: `event-${timestamp}`,
    type: "exit",
    status: "stopped",
    source: "flyd",
    timestamp,
  }

  return code === undefined
    ? { ...event, request: { exit_event: { requested_stop: true } } }
    : { ...event, request: { exit_event: { requested_stop: true, exit_code: code } } }
}

/**
 * A Fly Machines endpoint over real HTTP that keeps apps, addresses and
 * machines in memory, answering the way Fly's API does for the calls the
 * runner platform makes: unknown apps and machines are 404, a taken app or
 * machine name is 422, an idempotent app create returns its app, and a stop
 * takes two reads to show the machine stopped with the exit Fly records.
 */
export const flyFake = (script: FlyScript = {}) =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const calls: Array<FlyCall> = []
    const apps = new Map<string, FlyApp>()
    let sequence = 0
    let staleList = script.staleList === true

    const handle = (call: FlyCall, body: typeof Body.Type) => {
      const scripted = script.override?.(call)

      if (scripted !== undefined) return reply(scripted.status ?? 200, scripted.body)

      const parts = call.path.split("/").filter((part) => part !== "")
      const app = apps.get(parts[2] ?? "")

      if (parts[0] !== "v1" || parts[1] !== "apps") return reply(404, { error: "no route" })

      if (parts.length === 2 && call.method === "POST") {
        const name = body.name ?? ""
        const existing = apps.get(name)

        if (existing !== undefined && existing.key !== body.idempotency_key)
          return reply(422, { error: "Name has already been taken" })

        if (existing === undefined)
          apps.set(name, {
            name,
            organization: body.org_slug ?? "",
            network: body.network ?? "",
            key: body.idempotency_key,
            addresses: [],
            machines: [],
          })

        return reply(200, { id: `app-${name}`, created_at: 1 })
      }

      if (app === undefined) return reply(404, { error: `Could not find App "${parts[2] ?? ""}"` })

      if (parts.length === 3 && call.method === "GET")
        return reply(200, {
          id: `app-${app.name}`,
          name: app.name,
          network: app.network,
          organization: { slug: app.organization },
          status: "pending",
        })

      if (parts[3] === "ip_assignments") {
        if (call.method === "GET")
          return reply(200, { ips: app.addresses.map((address) => ({ ...address })) })

        sequence += 1

        const address =
          body.type === "v6"
            ? { ip: `2a09:8280:1::${sequence}`, shared: false }
            : { ip: `66.241.124.${sequence}`, shared: true }

        app.addresses.push(address)

        return reply(200, address)
      }

      if (parts[3] !== "machines") return reply(404, { error: "no route" })

      if (parts.length === 4 && call.method === "GET") {
        if (staleList) {
          staleList = false

          return reply(200, [])
        }

        return reply(200, app.machines.map(rendered))
      }

      if (parts.length === 4 && call.method === "POST") {
        if (body.region !== undefined && script.noCapacity?.includes(body.region) === true)
          return reply(script.capacityStatus ?? 412, {
            error:
              'failed to launch VM: insufficient resources to create new machine with VM size {"cpus":1}',
          })

        if (app.machines.some((machine) => machine.name === body.name))
          return reply(422, { error: "machine name already in use" })

        sequence += 1

        const machine: FlyMachine = {
          id: `d8${sequence.toString(16).padStart(12, "0")}`,
          name: body.name ?? "",
          region: body.region ?? "",
          state: script.createdAs?.state ?? "created",
          config: body.config ?? {},
          events:
            script.createdAs?.exit === undefined
              ? []
              : [exitEvent(script.createdAs.exit.code, sequence)],
          stopping: 0,
        }

        app.machines.push(machine)

        return reply(200, rendered(machine))
      }

      const machine = app.machines.find((candidate) => candidate.id === parts[4])

      if (machine === undefined)
        return reply(404, { error: `machine not found: ${parts[4] ?? ""}` })

      if (parts.length === 5 && call.method === "GET") {
        if (machine.state === "stopping" && machine.stopping > 0 && --machine.stopping === 0) {
          machine.state = "stopped"
          machine.events.unshift(exitEvent(0, sequence + 1000))
        }

        return reply(200, rendered(machine))
      }

      if (parts[5] === "stop" && call.method === "POST") {
        if (machine.state === "started") {
          machine.state = "stopping"
          machine.stopping = 2
        }

        return reply(200, {})
      }

      if (parts.length === 5 && call.method === "DELETE") {
        app.machines.splice(app.machines.indexOf(machine), 1)

        return reply(200, {})
      }

      return reply(404, { error: "no route" })
    }

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) =>
            run(
              Effect.gen(function* () {
                const text = yield* Effect.promise(() => request.text())
                const url = new URL(request.url)
                const call: FlyCall = {
                  method: request.method,
                  path: url.pathname,
                  query: Object.fromEntries(url.searchParams),
                  authorization: request.headers.get("authorization") ?? "",
                  body: text === "" ? undefined : yield* decodeJson(text),
                }

                calls.push(call)

                return handle(call, yield* decodeBody(call.body ?? {}))
              }).pipe(Effect.orDie),
            ),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )

    return {
      calls,
      apps,
      url: `http://127.0.0.1:${server.port}`,
      seed: (name: string, options: { readonly organization?: string } = {}) => {
        const created: FlyApp = {
          name,
          organization: options.organization ?? script.organization ?? "rika-labs-test",
          network: name,
          key: undefined,
          addresses: [],
          machines: [],
        }

        apps.set(name, created)

        return created
      },
    }
  })

/** The layers the runner platform needs, pointed at a fake and never retrying, so a scripted failure is seen at once. */
export const flyClient = (url: string) =>
  Layer.mergeAll(
    credentials({ apiKey: FLY_TOKEN, apiBaseUrl: url }),
    FetchHttpClient.layer,
    BunCrypto.layer,
    Layer.succeed(Retry, { while: () => false }),
  )
