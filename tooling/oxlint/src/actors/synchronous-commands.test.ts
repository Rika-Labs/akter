import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, it } from "vitest"
import { RuleTester } from "oxlint/plugins-dev"

import { synchronousCommandsRule } from "./synchronous-commands.ts"

RuleTester.describe = describe

RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

const contract = `import { Actor } from "@rikalabs/akter"
const Room = Actor.make("Room", {
  commands: { post: Actor.command(), count: Actor.command() },
  views: { summary: Actor.view() },
  jobs: { notify: Actor.job({}), "digest": Actor.job({}) },
})
`

const layer = (handlers: string) => `${contract}Room.toLayer({ ${handlers} })`

const command = (body: string) => layer(`post: (room, body, ctx) => { ${body} }`)

const job = (body: string) => layer(`notify: async (payload, job) => { ${body} }`)

const error = (messageId: string, data?: Record<string, string>) => ({ messageId, data })

const root = mkdtempSync(join(tmpdir(), "akter-synchronous-commands-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(join(root, "contracts"))

writeFileSync(
  join(root, "contracts", "room.ts"),
  `import { Actor } from "@rikalabs/akter"
export const Room = Actor.make("Room", {
  commands: { post: Actor.command() },
  jobs: { notify: Actor.job({}) },
})
export const Lobby = Actor.make("Lobby", { commands: { open: Actor.command() } })
export default Actor.make("Default", { jobs: { sync: Actor.job({}) } })
`,
)

writeFileSync(
  join(root, "contracts", "index.ts"),
  `export * from "./room.ts"
export { Room as Renamed } from "./room.ts"
export { default as Fallback } from "./room.ts"
`,
)

writeFileSync(
  join(root, "contracts", "cycle.ts"),
  `export * from "./cycle.ts"
`,
)

const implementation = (specifier: string, name: string, handlers: string) => ({
  code: `import { ${name} } from "${specifier}"\n${name.split(" as ").at(-1)}.toLayer({ ${handlers} })`,
  filename: join(root, "server", "room.ts"),
})

tester.run("akter/synchronous-commands", synchronousCommandsRule, {
  valid: [
    command("return ctx.now() + 1"),
    command("room.title = body; return ctx.random()"),
    command("const id = ctx.id(); room.items.put({ id })"),
    command("return Math.floor(1.5) + Math.ceil(1.5) + Math.round(1.5) + Math.trunc(1.5)"),
    command("return Math.abs(-1) + Math.min(1, 2) + Math.max(1, 2) + Math.sign(-3)"),
    command("return Math.sqrt(2) + Math.fround(1.1) + Math.clz32(8) + Math.imul(3, 4)"),
    command("return Math.PI + Math.E + Math.SQRT2 + Math.LN10"),
    command("return String(body) + body.toString()"),
    command("return body ? 2 * 2 : 2 + 2"),
    command("let n = 2; n *= 3; return n"),
    command("const Date = ctx; return Date.now()"),
    command("const { Date } = ctx; return Date.now()"),
    command("return room.Date + room.process + room.crypto + room.performance + ctx.Promise"),
    command("return { Date: 1, process: 2, Intl: 3 }"),
    command("const e = new Error('x'); return e.message"),
    command("try { return 1 } catch (error) { return error }"),
    command("try { return 1 } catch { return 2 }"),
    command("const cache: Map<string, Date> = new Map(); return cache.size"),
    layer("post: (room, at: Date, ctx): Promise<void> => undefined"),
    job("await Promise.resolve(Date.now())"),
    job("return Math.sin(Date.now() ** 2) + Math.random() + performance.now()"),
    job("try { await fetch('x') } catch (e) { return e.message + e.stack }"),
    job("return crypto.randomUUID() + process.env.HOME + globalThis.name"),
    job("setImmediate(() => {}); queueMicrotask(() => {}); clearTimeout(1); clearInterval(1)"),
    job("setTimeout(() => {}, 1); return new Intl.NumberFormat().format(1)"),
    job("return (1).toString(16) + 'a'.localeCompare('b') + structuredClone(payload)"),
    job("return Effect.gen(function* () { yield* Effect.sleep(1) })"),
    layer("notify: (payload, job) => Date.now(), digest: async () => await Promise.resolve(1)"),
    `${contract}const stamp = () => Date.now()\nRoom.toLayer({ post: (room) => stamp() })`,
    `${contract}function handlePost() { return Date.now() }\nRoom.toLayer({ post: handlePost })`,
    `${contract}Room.toLayer({ ...shared, [dynamic]: () => Date.now() })`,
    `${contract}Room.toLayer(makeHandlers())`,
    `${contract}Room.toLayer({ post: 1 })`,
    `const now = Date.now()\n${contract}`,
    `import { RpcGroup } from "effect/unstable/rpc"\nRpcGroup.toLayer({ post: () => Date.now() })`,
    `import { Room } from "@rikalabs/akter-rooms"\nRoom.toLayer({ post: () => Date.now() })`,
    `const Room = makeContract()\nRoom.toLayer({ post: () => Date.now() })`,
    `import { Room } from "./missing.ts"\nRoom.toLayer({ post: () => Date.now() })`,
    `import * as Contracts from "./room.ts"\nContracts.Room.toLayer({ post: () => Date.now() })`,
    `Actor.make("Room", { jobs: { notify: Actor.job({}) } }).toLayer({ notify: async () => await Date.now() })`,
    implementation("../contracts/room.ts", "Room", "notify: async () => { await Date.now() }"),
    implementation("../contracts/index.ts", "Room", "notify: async () => { await Date.now() }"),
    implementation(
      "../contracts/index.ts",
      "Renamed as Local",
      "notify: async () => { await Date.now() }",
    ),
    implementation("../contracts/index.ts", "Fallback", "sync: async () => { await Date.now() }"),
    implementation("../contracts/room.js", "Room", "notify: async () => { await Date.now() }"),
    implementation("../contracts/cycle.ts", "Room", "post: () => Date.now()"),
    `import { Actor } from "@rikalabs/akter"\nconst Room = Actor.make("Room")\nRoom.toLayer({ post: (Effect) => Effect.succeed(1) })`,
  ],
  invalid: [
    { code: command("return Date.now()"), errors: [error("date")] },
    { code: command("return new Date()"), errors: [error("date")] },
    { code: command("const D = Date; return D"), errors: [error("date")] },
    { code: command("return body instanceof Date"), errors: [error("date")] },
    { code: command("return Math.random()"), errors: [error("random")] },
    { code: command("return Math['random']()"), errors: [error("random")] },
    { code: command("return Math.sin(1)"), errors: [error("mathInexact", { name: "sin" })] },
    { code: command("return Math.cos(1)"), errors: [error("mathInexact", { name: "cos" })] },
    { code: command("return Math.exp(1)"), errors: [error("mathInexact", { name: "exp" })] },
    { code: command("return Math.log(1)"), errors: [error("mathInexact", { name: "log" })] },
    { code: command("return Math.pow(2, 3)"), errors: [error("mathInexact", { name: "pow" })] },
    { code: command("return Math.hypot(3, 4)"), errors: [error("mathInexact", { name: "hypot" })] },
    { code: command("return Math.cbrt(8)"), errors: [error("mathInexact", { name: "cbrt" })] },
    { code: command("return Math['tan'](2)"), errors: [error("mathInexact", { name: "tan" })] },
    { code: command("const m = Math; return m"), errors: [error("mathDynamic")] },
    { code: command("return Math[body](1)"), errors: [error("mathDynamic")] },
    { code: command("const { sin } = Math; return sin"), errors: [error("mathDynamic")] },
    { code: command("return 2 ** 8"), errors: [error("exponent")] },
    { code: command("let n = 2; n **= 3; return n"), errors: [error("exponent")] },
    { code: command("return crypto.randomUUID()"), errors: [error("crypto")] },
    { code: command("return performance.now()"), errors: [error("performance")] },
    { code: command("return process.env.HOME"), errors: [error("process")] },
    { code: command("return globalThis.name"), errors: [error("globalThis")] },
    { code: command("return Promise.resolve(1)"), errors: [error("promise")] },
    { code: command("return new Promise(() => {})"), errors: [error("promise")] },
    {
      code: layer("post: async (room) => { await room.sync() }"),
      errors: [error("asyncFunction"), error("await")],
    },
    {
      code: layer("post: async function (room) { return 1 }"),
      errors: [error("asyncFunction")],
    },
    {
      code: layer("async post(room) { return 1 }"),
      errors: [error("asyncFunction")],
    },
    {
      code: command("return async () => 1"),
      errors: [error("asyncFunction")],
    },
    {
      code: command("const wait = async function () { return 1 }; return wait"),
      errors: [error("asyncFunction")],
    },
    {
      code: command("async function later() { return 1 } return later"),
      errors: [error("asyncFunction")],
    },
    {
      code: command("return (async () => { await 1 })"),
      errors: [error("asyncFunction"), error("await")],
    },
    {
      code: layer("post: async (room, body) => { for await (const x of body) { x } }"),
      errors: [error("asyncFunction"), error("await")],
    },
    { code: command("return setTimeout(() => {}, 1)"), errors: [error("timer")] },
    { code: command("return setInterval(() => {}, 1)"), errors: [error("timer")] },
    { code: command("return setImmediate(() => {})"), errors: [error("timer")] },
    { code: command("queueMicrotask(() => {})"), errors: [error("timer")] },
    { code: command("clearTimeout(body)"), errors: [error("timer")] },
    { code: command("clearInterval(body)"), errors: [error("timer")] },
    { code: command("return new Intl.NumberFormat().format(1)"), errors: [error("intl")] },
    {
      code: command("return body.toLocaleString()"),
      errors: [error("locale", { name: "toLocaleString" })],
    },
    {
      code: command("return body.toLocaleDateString('en')"),
      errors: [error("locale", { name: "toLocaleDateString" })],
    },
    {
      code: command("return body.toLocaleTimeString()"),
      errors: [error("locale", { name: "toLocaleTimeString" })],
    },
    {
      code: command("return body.localeCompare('a')"),
      errors: [error("locale", { name: "localeCompare" })],
    },
    {
      code: command("return room.names.sort((a, b) => a.localeCompare(b))"),
      errors: [error("locale", { name: "localeCompare" })],
    },
    { code: command("return (255).toString(16)"), errors: [error("radix")] },
    { code: command("return body?.toString(2)"), errors: [error("radix")] },
    {
      code: command("try { return 1 } catch (e) { return e.message }"),
      errors: [error("errorDetail", { name: "message" })],
    },
    {
      code: command("try { return 1 } catch (e) { return e.stack }"),
      errors: [error("errorDetail", { name: "stack" })],
    },
    {
      code: command("try { return 1 } catch (e) { return e?.['message'] }"),
      errors: [error("errorDetail", { name: "message" })],
    },
    {
      code: command("try { return 1 } catch ({ message }) { return message }"),
      errors: [error("errorDetail", { name: "message" })],
    },
    {
      code: command("try { return 1 } catch ({ stack: trace }) { return trace }"),
      errors: [error("errorDetail", { name: "stack" })],
    },
    { code: command("return structuredClone(room)"), errors: [error("structuredClone")] },
    { code: command("return Effect.succeed(1)"), errors: [error("effect")] },
    {
      code: layer("post: function* (room) { yield* room.next() }"),
      errors: [error("yield")],
    },
    {
      code: layer("post: function* (room) { yield room.next() }"),
      errors: [error("yield")],
    },
    {
      code: layer("summary: (room) => Date.now()"),
      errors: [error("date")],
    },
    {
      code: layer("summary: (room) => Math.sin(room.angle)"),
      errors: [error("mathInexact", { name: "sin" })],
    },
    {
      code: layer("connect: (room, presence, { connection }) => { room.at = performance.now() }"),
      errors: [error("performance")],
    },
    {
      code: layer("disconnect: (room) => { room.at = Date.now() }"),
      errors: [error("date")],
    },
    {
      code: layer("post: function (room) { return Date.now() }"),
      errors: [error("date")],
    },
    {
      code: layer("post(room) { return Date.now() }"),
      errors: [error("date")],
    },
    {
      code: layer("'post': (room) => Date.now()"),
      errors: [error("date")],
    },
    {
      code: layer("notify: (payload) => Date.now(), post: (room) => Date.now()"),
      errors: [error("date")],
    },
    {
      code: command("const stamp = () => Date.now(); return stamp()"),
      errors: [error("date")],
    },
    {
      code: command("function stamp() { return Math.sin(1) } return stamp()"),
      errors: [error("mathInexact", { name: "sin" })],
    },
    {
      code: command("return room.items.map((item) => item.at ** 2)"),
      errors: [error("exponent")],
    },
    {
      code: command("return Date.now() + performance.now() + Math.random()"),
      errors: [error("date"), error("performance"), error("random")],
    },
    {
      code: command("return Math.sin(2) ** 2"),
      errors: [error("exponent"), error("mathInexact", { name: "sin" })],
    },
    {
      code: command("return Date.now() + Date.now()"),
      errors: [error("date"), error("date")],
    },
    {
      code: command("return Math.sin(Math.cos(1))"),
      errors: [error("mathInexact", { name: "sin" }), error("mathInexact", { name: "cos" })],
    },
    {
      code: `${contract}Room.toLayer({ post: () => Date.now() })\nRoom.toLayer({ post: () => performance.now() })`,
      errors: [error("date"), error("performance")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nexport const Room = Actor.make("Room", { jobs: { notify: Actor.job({}) } })\nRoom.toLayer({ post: () => Date.now() })`,
      errors: [error("date")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nconst Room = Actor.make("Room", { commands: {} } satisfies Definition) as Contract\nRoom.toLayer({ post: () => Date.now() })`,
      errors: [error("date")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nconst Room = Actor.make("Room")\nRoom.toLayer({ post: () => Date.now() })`,
      errors: [error("date")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nconst Room = Actor.make("Room", { jobs: { notify: Actor.job({}) } })\nRoom.toLayer({ notify: () => Date.now(), post: () => Date.now() })`,
      errors: [error("date")],
    },
    {
      code: `Actor.make("Room", { jobs: { notify: Actor.job({}) } }).toLayer({ post: () => Date.now(), notify: () => Date.now() })`,
      errors: [error("date")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nconst Room = Actor.make("Room", { jobs: { notify: Actor.job({}) } })\nRoom.toLayer({ digest: async () => await 1 })`,
      errors: [error("asyncFunction"), error("await")],
    },
    {
      code: `import { Actor } from "@rikalabs/akter"\nimport { Effect } from "effect"\nconst Room = Actor.make("Room")\nRoom.toLayer({ post: () => Effect.succeed(1) })`,
      errors: [error("effect")],
    },
    {
      ...implementation("../contracts/room.ts", "Room", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation(
        "../contracts/room.ts",
        "Room",
        "notify: async () => await 1, post: async () => await 1",
      ),
      errors: [error("asyncFunction"), error("await")],
    },
    {
      ...implementation("../contracts/index.ts", "Room", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation("../contracts/index.ts", "Renamed as Local", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation("../contracts", "Room", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation("../contracts/index.ts", "Fallback", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation("../contracts/room.js", "Room", "post: () => Date.now()"),
      errors: [error("date")],
    },
    {
      ...implementation("../contracts/room.ts", "Lobby", "open: () => Date.now()"),
      errors: [error("date")],
    },
  ],
})
