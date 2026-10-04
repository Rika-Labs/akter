import { expect, type Page, test, type Route } from "@playwright/test"
import { Deferred, Effect, Schema } from "effect"

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
const streamingPeer = `http://127.0.0.1:${process.env.E2E_STREAM_PORT ?? "3540"}`
const StreamStats = Schema.Struct({
  opened: Schema.Int,
  active: Schema.Int,
  closed: Schema.Int,
  maximum: Schema.Int,
})
const session =
  '{"user":{"id":"runtime_user","name":"Runtime Operator","email":"runtime@example.com","emailVerified":true},"session":{"id":"runtime_session"}}'
const me =
  '{"user":{"id":"runtime_user","name":"Runtime Operator","email":"runtime@example.com","emailVerified":true,"image":null},"identityKind":"session","activeOrganizationId":"runtime_org","organizations":[{"role":"owner","organization":{"id":"runtime_org","name":"Runtime Org","slug":"runtime-org","plan":"free","createdAt":"2026-01-01T00:00:00Z"}}]}'
const projects =
  '[{"id":"runtime_project","organizationId":"runtime_org","name":"Runtime Project","slug":"runtime-project","status":"live","homeRegion":"us-west-2","createdAt":"2026-01-01T00:00:00Z"}]'
const actorType = {
  name: "Order",
  commands: ["Refund"],
  instances: 7,
  awake: 3,
  commandsPerSecond: 11,
  p99Ms: 27,
  maxMailbox: 2,
}
const inspector = {
  address: "Order/ord-live",
  state: { total: 37 },
  turn: 9,
  tables: [],
  receipts: [],
  events: [],
  jobs: [],
  connections: { sockets: 0, feedCursor: null },
  properties: {
    status: "awake",
    type: "Order",
    generation: 4,
    runner: "runner_live",
    region: "us-west-2",
    tenant: "tenant_live",
    mailboxDepth: 0,
  },
  timeline: [],
}

const controlPlane = (route: Route) => {
  const path = new URL(route.request().url()).pathname
  if (path === "/api/me") return route.fulfill({ contentType: "application/json", body: me })
  if (path === "/api/organizations/runtime_org/projects")
    return route.fulfill({ contentType: "application/json", body: projects })
  if (path === "/api/me/pinned-actors") return route.fulfill({ json: [] })
  return route.fulfill({
    status: 501,
    contentType: "application/json",
    body: '{"_tag":"NotImplemented","operation":"pending.endpoint"}',
  })
}

test("shows command replay and typed actor failure without losing their payloads", async ({
  page,
}) => {
  let sends = 0
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Order/ord-live")) return route.fulfill({ json: inspector })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sends += 1
      const body = route.request().postDataJSON()
      expect(body.address).toBe("Order/ord-live")
      expect(body.command).toBe("Refund")
      if (sends === 1) {
        expect(body.payload).toEqual({ amount: 17 })
        expect(body.commandId).toBe("retry-17")
        return route.fulfill({
          json: { commandId: "retry-17", result: { balance: 23 }, replayed: true },
        })
      }
      expect(body.payload).toEqual({ amount: 99 })
      expect(body.commandId).toBe("refused-99")
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: '{"_tag":"CommandFailed","commandId":"refused-99","errorTag":"InsufficientFunds","error":{"available":23},"replayed":true}',
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Order/ord-live`)
  await expect(page.getByRole("heading", { name: "Order/ord-live" })).toBeVisible()
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":17}')
  await dialog.getByLabel("Command ID (optional)").fill("retry-17")
  await dialog.getByRole("button", { name: "Send command" }).click()
  await expect(dialog.getByText("Replayed — returned the stored receipt.")).toBeVisible()
  await expect(dialog.getByRole("figure")).toContainText('"balance": 23')
  await dialog.getByLabel("Payload", { exact: true }).fill("{bad-json}")
  await dialog.getByRole("button", { name: "Send command" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("The payload isn’t valid JSON.")
  expect(sends).toBe(1)
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":99}')
  await dialog.getByLabel("Command ID (optional)").fill("refused-99")
  await dialog.getByRole("button", { name: "Send command" }).click()
  await expect(dialog.getByRole("alert")).toContainText(
    "CommandFailed · InsufficientFunds · replayed receipt",
  )
  await expect(dialog.getByRole("figure")).toContainText('"available": 23')
  expect(sends).toBe(2)
  await expect(page.getByRole("note")).toHaveCount(0)
})

test("decodes command SSE into the tail and refreshes the snapshot on reconnect", async ({
  page,
}) => {
  let snapshots = 0
  let streams = 0
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actor-types")) return route.fulfill({ json: [actorType] })
    if (path.endsWith("/runtime/commands")) {
      snapshots += 1
      return route.fulfill({ json: { items: [], nextCursor: null } })
    }
    if (path.endsWith("/runtime/commands/stream")) {
      streams += 1
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"at":"2026-10-03T12:34:56.789Z","durationMs":7.5,"address":"Order/team/a","command":"Refund","payloadPreview":"","outcome":"error","errorTag":"Denied"}\n\n',
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/commands`)
  const table = page.getByRole("table", { name: "Committed turns, newest first" })
  await expect(table).toContainText("12:34:56.789")
  await expect(table).toContainText("Order/team/a")
  await expect(table).toContainText("Denied")
  await expect(
    page.getByText("The live connection ended. Reconnect to refresh commands."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Reconnect" }).click()
  await expect.poll(() => snapshots).toBe(2)
  await expect.poll(() => streams).toBe(2)
  await expect(table).toContainText("Order/team/a")
  await expect(page.getByRole("note")).toHaveCount(0)
})

test("holds one live stream and cancels it on pause and client navigation", async ({ page }) => {
  expect((await page.request.get(`${streamingPeer}/reset`)).status()).toBe(204)
  const stats = async () =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(StreamStats)(
        await (await page.request.get(`${streamingPeer}/stats`)).json(),
      ),
    )
  try {
    await page.route("**/auth/get-session", (route) =>
      route.fulfill({ contentType: "application/json", body: session }),
    )
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith("/runtime/commands/stream"))
        return route.continue({ url: `${streamingPeer}/stream` })
      if (path.endsWith("/runtime/commands"))
        return route.fulfill({ json: { items: [], nextCursor: null } })
      if (path.endsWith("/runtime/actor-types")) return route.fulfill({ json: [actorType] })
      return controlPlane(route)
    })
    await page.goto(`${origin}/commands`)
    await expect(page.getByRole("main").getByText("Live", { exact: true })).toBeVisible()
    await expect.poll(async () => (await stats()).active).toBe(1)
    await page.getByRole("combobox", { name: "Actor type" }).selectOption("Order")
    expect((await stats()).opened).toBe(1)
    await page.getByRole("button", { name: "Pause", exact: true }).click()
    await expect.poll(async () => (await stats()).closed).toBe(1)
    await expect.poll(async () => (await stats()).active).toBe(0)
    await page.getByRole("button", { name: "Reconnect", exact: true }).click()
    await expect.poll(async () => (await stats()).opened).toBe(2)
    await expect(page.getByRole("main").getByText("Live", { exact: true })).toBeVisible()
    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Actors", exact: true })
      .click()
    await expect.poll(async () => (await stats()).closed).toBe(2)
    await expect.poll(async () => (await stats()).active).toBe(0)
    expect((await stats()).maximum).toBe(1)
  } finally {
    await page.close()
  }
})

test("a blank command ID survives an ambiguous send and blocks double submission", async ({
  page,
}) => {
  const ids: Array<string> = []
  const held = Deferred.makeUnsafe<void>()
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Order/ord-live")) return route.fulfill({ json: inspector })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      ids.push(body.commandId)
      if (ids.length === 1) {
        await Effect.runPromise(Deferred.await(held))
        return route.abort("failed")
      }
      return route.fulfill({
        json: { commandId: body.commandId, result: { balance: 23 }, replayed: true },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Order/ord-live`)
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByLabel("Command ID (optional)").fill("")
  const submit = dialog.getByRole("button", { name: "Send command", exact: true })
  await submit.click()
  await expect.poll(() => ids.length).toBe(1)
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  await expect(submit).toBeDisabled()
  await submit.dispatchEvent("click")
  expect(ids).toHaveLength(1)
  await Effect.runPromise(Deferred.succeed(held, undefined))
  await expect(dialog.getByRole("alert")).toHaveText("We couldn’t reach Akter. Please try again.")
  await expect(dialog.getByLabel("Command ID (optional)")).toHaveValue(ids[0]!)
  await expect(dialog).toContainText(`Command ID used: ${ids[0]}`)
  await submit.click()
  await expect(dialog).toContainText("Replayed — returned the stored receipt.")
  expect(ids).toEqual([ids[0], ids[0]])
})

test("navigation closes the send dialog before switching project scope", async ({ page }) => {
  let sends = 0
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Order/ord-live")) return route.fulfill({ json: inspector })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sends += 1
      return route.abort()
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Order/ord-live`)
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("production (runtime_project)")
  await page.evaluate(() => {
    sessionStorage.setItem("console-project", "another-project")
    history.pushState({}, "", "/projects/another-project")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(sends).toBe(0)
})

test("reloads activity and per-command volumes for the selected window", async ({ page }) => {
  const windows: Array<string | null> = []
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/actor-types/Order")) return route.fulfill({ json: actorType })
    if (url.pathname.endsWith("/actor-types/Order/instances"))
      return route.fulfill({ json: { items: [], nextCursor: null } })
    if (url.pathname.endsWith("/actor-types/Order/activity")) {
      const window = url.searchParams.get("window")
      windows.push(window)
      return route.fulfill({
        json: {
          window,
          series: [
            { at: "2026-10-03T10:00:00Z", value: 4 },
            { at: "2026-10-03T11:00:00Z", value: 13 },
          ],
          commands: [
            { command: window === "1h" ? "RefundHour" : "RefundDay", count: 17, perSecond: 0.7 },
          ],
        },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Order`)
  await expect(page.getByRole("heading", { name: "Order", exact: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Order commands, last 24 hours" })).toContainText(
    "RefundDay",
  )
  await page.getByRole("button", { name: "Time range: last 24 hours" }).click()
  await page.getByRole("button", { name: "Last hour", exact: true }).click()
  await expect(page.getByRole("list", { name: "Order commands, last hour" })).toContainText(
    "RefundHour",
  )
  expect(windows).toEqual(["24h", "1h"])
})

test("rolls back to the previous successful deployment and shows the returned provenance", async ({
  page,
}) => {
  const current = {
    id: "deploy_current",
    projectId: "runtime_project",
    environment: "production",
    commitSha: "aaaaaaa",
    message: "Current release",
    author: { name: "Operator", image: null },
    regions: ["us-west-2"],
    runnerCount: 2,
    durationMs: 40,
    status: "live",
    rolledBackFrom: null,
    createdAt: "2026-10-03T10:00:00Z",
  }
  const target = {
    ...current,
    id: "deploy_target",
    commitSha: "bbbbbbb",
    message: "Previous release",
    status: "drained",
    createdAt: "2026-10-03T08:00:00Z",
  }
  const failed = {
    ...current,
    id: "deploy_failed",
    commitSha: "ccccccc",
    message: "Failed release",
    status: "failed",
    createdAt: "2026-10-03T09:00:00Z",
  }
  const next = {
    ...target,
    id: "deploy_rollback",
    message: "Restoring previous release",
    status: "in-progress",
    rolledBackFrom: "deploy_target",
    createdAt: "2026-10-03T11:00:00Z",
  }
  let posted = false
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/projects/runtime_project/deployments")
      return route.fulfill({
        json: {
          items: posted ? [next, current, failed, target] : [current, failed, target],
          nextCursor: null,
        },
      })
    if (path.endsWith("/rollback") && route.request().method() === "POST") {
      expect(path).toBe("/api/projects/runtime_project/deployments/deploy_target/rollback")
      posted = true
      return route.fulfill({ json: { ...next, steps: [], runners: [] } })
    }
    if (path.endsWith("/build-log")) return route.fulfill({ json: { lines: [], complete: true } })
    if (path.endsWith("/deployments/deploy_current"))
      return route.fulfill({ json: { ...current, steps: [], runners: [] } })
    if (path.endsWith("/deployments/deploy_rollback"))
      return route.fulfill({ json: { ...next, steps: [], runners: [] } })
    return controlPlane(route)
  })
  await page.goto(`${origin}/deployments/aaaaaaa`)
  await expect(page.getByRole("heading", { name: "Current release" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Roll back to" })).toHaveValue("deploy_target")
  await expect(page.getByRole("option")).toHaveCount(1)
  await page.getByRole("button", { name: "Roll back", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Roll back", exact: true }).click()
  await expect(page).toHaveURL(`${origin}/deployments/deploy_rollback`)
  await expect(page.getByRole("heading", { name: "Restoring previous release" })).toBeVisible()
  await expect(page.getByRole("main")).toContainText("rolled back from bbbbbbb")
  expect(posted).toBe(true)
})

interface RunnerRow {
  readonly id: string
  readonly region: string
  readonly actorCount: number | null
  readonly cpuPercent: number | null
  readonly health: string
}

const liveDeployment = {
  id: "deploy_live",
  projectId: "runtime_project",
  environment: "production",
  commitSha: "aaaaaaa",
  message: "Current release",
  author: { name: "Operator", image: null },
  regions: ["us-west-2"],
  runnerCount: 2,
  durationMs: 40 as number | null,
  status: "live",
  rolledBackFrom: null,
  createdAt: "2026-10-03T10:00:00Z",
}
const drainedDeployment = {
  ...liveDeployment,
  id: "deploy_drained",
  commitSha: "bbbbbbb",
  message: "Previous release",
  status: "drained",
  createdAt: "2026-10-03T08:00:00Z",
}

const serveDeployments = (
  page: Page,
  options: Readonly<{
    history?: () => ReadonlyArray<typeof liveDeployment>
    runners?: ReadonlyArray<RunnerRow>
    onPost: (path: string, route: Route) => Promise<void>
  }>,
) =>
  page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST") return options.onPost(path, route)
    const history = options.history?.() ?? [liveDeployment, drainedDeployment]
    if (path === "/api/projects/runtime_project/deployments")
      return route.fulfill({ json: { items: history, nextCursor: null } })
    if (path.endsWith("/build-log")) return route.fulfill({ json: { lines: [], complete: true } })
    const detail = history.find((deployment) => path.endsWith(`/deployments/${deployment.id}`))
    if (detail !== undefined)
      return route.fulfill({ json: { ...detail, steps: [], runners: options.runners ?? [] } })
    return controlPlane(route)
  })

test("shows unmeasured runner telemetry as unknown and measured zeroes as zero", async ({
  page,
}) => {
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await serveDeployments(page, {
    runners: [
      {
        id: "runner-unmeasured",
        region: "us-west-2",
        actorCount: null,
        cpuPercent: null,
        health: "healthy",
      },
      { id: "runner-idle", region: "us-west-2", actorCount: 0, cpuPercent: 0, health: "starting" },
    ],
    onPost: () => Promise.reject(new Error("viewing a deployment must not change it")),
  })
  await page.goto(`${origin}/deployments/deploy_live`)
  const runners = page.getByRole("table", { name: "Runners" })
  await expect(runners.getByRole("row").filter({ hasText: "runner-unmeasured" })).toContainText(
    /us-west-2\s*—\s*—\s*Healthy/,
  )
  await expect(runners.getByRole("row").filter({ hasText: "runner-idle" })).toContainText(
    /us-west-2\s*0\s*0%\s*Starting/,
  )
  await expect(page.getByRole("note")).toHaveCount(0)
})

test("asks before rolling back and shows a refused rollback instead of a success", async ({
  page,
}) => {
  const posts: Array<string> = []
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await serveDeployments(page, {
    onPost: (path, route) => {
      posts.push(path)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"_tag":"Conflict","message":"A rollout is already in progress"}',
      })
    },
  })
  await page.goto(`${origin}/deployments/deploy_live`)
  await expect(page.getByRole("heading", { name: "Current release" })).toBeVisible()
  await page.getByRole("button", { name: "Roll back", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Roll back to bbbbbbb?")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  expect(posts).toEqual([])
  await page.getByRole("button", { name: "Roll back", exact: true }).click()
  await dialog.getByRole("button", { name: "Roll back", exact: true }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "A rollout is already in progress" }),
  ).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Rolling back" })).toHaveCount(0)
  await expect(page).toHaveURL(`${origin}/deployments/deploy_live`)
  expect(posts).toEqual(["/api/projects/runtime_project/deployments/deploy_drained/rollback"])
})

test("asks before redeploying and opens the new deployment the server started", async ({
  page,
}) => {
  const posts: Array<string> = []
  const started = {
    ...liveDeployment,
    id: "deploy_again",
    message: "Redeploy deploy_live",
    status: "in-progress",
    durationMs: null,
    createdAt: "2026-10-03T11:00:00Z",
  }
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await serveDeployments(page, {
    history: () =>
      posts.length === 0
        ? [liveDeployment, drainedDeployment]
        : [started, liveDeployment, drainedDeployment],
    onPost: (path, route) => {
      posts.push(path)
      return route.fulfill({ json: { ...started, steps: [], runners: [] } })
    },
  })
  await page.goto(`${origin}/deployments/deploy_live`)
  await page.getByRole("button", { name: "Redeploy", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Redeploy aaaaaaa?")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  expect(posts).toEqual([])
  await page.getByRole("button", { name: "Redeploy", exact: true }).click()
  await dialog.getByRole("button", { name: "Redeploy", exact: true }).click()
  await expect(page).toHaveURL(`${origin}/deployments/deploy_again`)
  await expect(page.getByRole("heading", { name: "Redeploy deploy_live" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Redeploy", exact: true })).toBeDisabled()
  expect(posts).toEqual(["/api/projects/runtime_project/deployments/deploy_live/redeploy"])
})

test("reloads the overview latency histogram window and preserves its unbounded tail", async ({
  page,
}) => {
  const windows: Array<string | null> = []
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/runtime/overview"))
      return route.fulfill({
        json: {
          commands: { perSecond: 11, series24h: [], p50Ms: 1, p99Ms: 29 },
          actors: { awake: 3, total: 7 },
          jobs: { inFlight: 0, donePerHour: 0 },
          deadLettersByJobType: [],
          throughput: [],
          p99: [],
          health: {
            runners: { healthy: 1, total: 1 },
            databaseCpuPercent: 13,
            maxMailbox: { depth: 0, actor: null },
            parkedSockets: 0,
            outboxLagP99Ms: 0,
            lastDeployAt: null,
          },
          recentDeployments: [],
        },
      })
    if (url.pathname.endsWith("/runtime/actor-types")) return route.fulfill({ json: [actorType] })
    if (url.pathname.endsWith("/actor-types/Order/latency")) {
      const window = url.searchParams.get("window")
      windows.push(window)
      return route.fulfill({
        json: {
          window,
          buckets: [
            { upToMs: 2, count: window === "7d" ? 19 : 7 },
            { upToMs: null, count: 13 },
          ],
          p50Ms: 1,
          p95Ms: 17,
          p99Ms: 29,
        },
      })
    }
    return controlPlane(route)
  })
  await page.goto(origin)
  const distribution = page.getByRole("region", { name: "Turn latency distribution" })
  await expect(distribution).toContainText("≤ 2.0 ms: 7, > 2.0 ms: 13")
  await page.getByRole("button", { name: "Time range: last 24 hours" }).click()
  await page.getByRole("button", { name: "Last 7 days", exact: true }).click()
  await expect(distribution).toContainText("≤ 2.0 ms: 19, > 2.0 ms: 13")
  expect(windows).toEqual(["24h", "7d"])
})
