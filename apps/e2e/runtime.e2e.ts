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
  '{"user":{"id":"runtime_user","name":"Runtime Operator","email":"runtime@example.com","emailVerified":true,"image":null},"identityKind":"session","activeOrganizationId":"runtime_org","organizations":[{"role":"owner","organization":{"id":"runtime_org","name":"Runtime Org","slug":"runtime-org","plan":{"_tag":"known","id":"free"},"createdAt":"2026-01-01T00:00:00Z"}}]}'
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

const deploymentNotFound = (path: string) => ({
  status: 404,
  contentType: "application/json",
  body: `{"_tag":"NotFound","resource":"deployment","id":"${path.split("/").at(-1) ?? ""}"}`,
})

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
        body: 'data: {"commandId":"cmd_sse","at":"2026-10-03T12:34:56.789Z","durationMs":7.5,"address":"Order/team/a","command":"Refund","caller":null,"payloadPreview":"","outcome":"error","errorTag":"Denied"}\n\n',
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
    if (/\/deployments\/[^/]+$/.test(path)) return route.fulfill(deploymentNotFound(path))
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
  rolledBackFrom: null as string | null,
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

test("keeps live jobs and command sending on an inspector the runtime cannot inspect yet", async ({
  page,
}) => {
  let sent = 0
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Counter/hits/jobs"))
      return route.fulfill({
        json: [{ name: "Notify", id: "job_live_7", attempts: 2, status: "retrying" }],
      })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sent += 1
      expect(route.request().postDataJSON()).toMatchObject({
        address: "Counter/hits",
        command: "Increment",
        payload: 3,
      })
      return route.fulfill({
        json: { commandId: "cmd_live", result: { count: 3 }, replayed: false },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Counter/hits?tab=jobs`)
  await expect(page.getByRole("heading", { name: "Counter/hits" })).toBeVisible()
  await expect(page.getByRole("note")).toContainText("Sample data")
  await expect(page.getByRole("table", { name: "Jobs" })).toContainText("job_live_7")
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Increment")
  await dialog.getByLabel("Payload", { exact: true }).fill("3")
  await dialog.getByRole("button", { name: "Send command" }).click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  await expect(dialog.getByRole("figure")).toContainText('"count": 3')
  expect(sent).toBe(1)
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

const signIn = (page: Page) =>
  page.route("**/auth/get-session", (route) =>
    route.fulfill({ contentType: "application/json", body: session }),
  )

const commandRoute = (
  page: Page,
  answer: (body: { commandId: string; payload: unknown }) => Parameters<Route["fulfill"]>[0],
) =>
  page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Order/ord-live")) return route.fulfill({ json: inspector })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST")
      return route.fulfill(answer(route.request().postDataJSON()))
    return controlPlane(route)
  })

const openSendDialog = async (page: Page) => {
  await page.goto(`${origin}/actors/Order/ord-live`)
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Refund")
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":17}')
  return { dialog, submit: dialog.getByRole("button", { name: "Send command", exact: true }) }
}

test("retries a submission with its own command ID, shows the replay quietly and mints a new ID for new input", async ({
  page,
}) => {
  const ids: Array<string> = []
  await signIn(page)
  await commandRoute(page, (body) => {
    const replayed = ids.includes(body.commandId)
    ids.push(body.commandId)
    return { json: { commandId: body.commandId, result: { balance: ids.length }, replayed } }
  })
  const { dialog, submit } = await openSendDialog(page)
  await expect(dialog.getByLabel("Command ID (optional)")).toHaveValue("")
  await submit.click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  await submit.click()
  await expect(dialog.getByText("Replayed — returned the stored receipt.")).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await dialog.getByLabel("Payload", { exact: true }).fill('{ "amount": 17 }')
  await expect(
    dialog.getByText("The command or payload changed, so sending it uses a new command ID."),
  ).toHaveCount(0)
  await dialog.getByLabel("Payload", { exact: true }).fill('{"amount":18}')
  await expect(
    dialog.getByText("The command or payload changed, so sending it uses a new command ID."),
  ).toBeVisible()
  await submit.click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  expect(ids).toHaveLength(3)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).toMatch(/^[0-9a-f-]{36}$/)
  expect(ids[2]).not.toBe(ids[0])
  await expect(dialog.getByLabel("Command ID (optional)")).toHaveValue(ids[2]!)
})

test("explains an expired command ID and only sends again as a new command", async ({ page }) => {
  const ids: Array<string> = []
  await signIn(page)
  await commandRoute(page, (body) => {
    ids.push(body.commandId)
    return ids.length === 1
      ? {
          status: 410,
          contentType: "application/json",
          body: `{"_tag":"CommandExpired","commandId":"${body.commandId}"}`,
        }
      : { json: { commandId: body.commandId, result: { balance: 3 }, replayed: false } }
  })
  const { dialog, submit } = await openSendDialog(page)
  await dialog.getByLabel("Command ID (optional)").fill("old-key")
  await submit.click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "This command ID’s retry window has closed, so Akter won’t run it again. Clear the Command ID to send it as a new command.",
  )
  await expect(submit).toBeDisabled()
  await dialog.getByLabel("Command ID (optional)").fill("")
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  expect(ids[0]).toBe("old-key")
  expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/)
})

test("reports a runner defect once and offers no retry", async ({ page }) => {
  let sends = 0
  await signIn(page)
  await commandRoute(page, () => {
    sends += 1
    return { status: 502, contentType: "application/json", body: '{"_tag":"RunnerDefect"}' }
  })
  const { dialog, submit } = await openSendDialog(page)
  await submit.click()
  await expect(dialog.getByRole("alert")).toContainText(
    "The runner hit an internal error while running this command. It wasn’t retried and can’t be resent with this command ID.",
  )
  await expect(submit).toBeDisabled()
  await submit.dispatchEvent("click")
  await page.waitForTimeout(300)
  expect(sends).toBe(1)
})

test("offers Send first command for an actor no command has reached, and only then", async ({
  page,
}) => {
  const sent: Array<unknown> = []
  await signIn(page)
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Counter/fresh/jobs"))
      return sent.length === 0
        ? route.fulfill({
            status: 404,
            contentType: "application/json",
            body: '{"_tag":"NotFound","resource":"actor","id":"Counter/fresh"}',
          })
        : route.fulfill({ json: [] })
    if (path.endsWith("/runtime/actors/Counter/denied/jobs"))
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"_tag":"Forbidden","message":"No access to this actor"}',
      })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sent.push(route.request().postDataJSON())
      return route.fulfill({
        json: { commandId: "cmd_first", result: { count: 1 }, replayed: false },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Counter/denied`)
  await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send first command" })).toHaveCount(0)

  await page.goto(`${origin}/actors/Counter/fresh`)
  await expect(
    page.getByRole("heading", { name: "Counter/fresh hasn’t received a command yet" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Send first command" }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await expect(dialog).toContainText("To Counter/fresh in production (runtime_project)")
  await dialog.getByLabel("Command", { exact: true }).fill("Increment")
  await dialog.getByLabel("Payload", { exact: true }).fill("1")
  await dialog.getByRole("button", { name: "Send command", exact: true }).click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  expect(sent).toEqual([
    expect.objectContaining({ address: "Counter/fresh", command: "Increment", payload: 1 }),
  ])
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("heading", { name: "Counter/fresh", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send first command" })).toHaveCount(0)
})

const rollback = {
  ...drainedDeployment,
  id: "deploy_rollback",
  message: "Rollback to bbbbbbb: Previous release",
  status: "in-progress",
  durationMs: null,
  rolledBackFrom: "deploy_drained",
  createdAt: "2026-10-03T11:00:00Z",
}

/** Serves the live and drained deployments and holds every POST until `release` resolves. */
const holdRollback = async (page: Page) => {
  const posts: Array<string> = []
  const held = Deferred.makeUnsafe<void>()
  await signIn(page)
  await serveDeployments(page, {
    history: () =>
      posts.length === 0
        ? [liveDeployment, drainedDeployment]
        : [rollback, liveDeployment, drainedDeployment],
    onPost: async (path, route) => {
      posts.push(path)
      await Effect.runPromise(Deferred.await(held))
      await route.fulfill({ json: { ...rollback, steps: [], runners: [] } })
    },
  })
  return { posts, release: () => Effect.runPromise(Deferred.succeed(held, undefined)) }
}

test("a double-clicked rollback sends one POST and opens the new deployment under its own title", async ({
  page,
}) => {
  const { posts, release } = await holdRollback(page)
  await page.goto(`${origin}/deployments/deploy_live`)
  await page.getByRole("button", { name: "Roll back", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Roll back", exact: true }).dblclick()
  await expect.poll(() => posts.length).toBe(1)
  await expect(page.getByRole("button", { name: "Roll back", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Redeploy", exact: true })).toBeDisabled()
  await page.waitForTimeout(300)
  expect(posts).toEqual(["/api/projects/runtime_project/deployments/deploy_drained/rollback"])
  await release()
  await expect(page).toHaveURL(`${origin}/deployments/deploy_rollback`)
  await expect(
    page.getByRole("heading", { name: "Rollback to bbbbbbb: Previous release" }),
  ).toBeVisible()
  expect(posts).toHaveLength(1)
})

test("stays on the page the user moved to when a rollback lands", async ({ page }) => {
  const { posts, release } = await holdRollback(page)
  await page.goto(`${origin}/deployments/deploy_live`)
  await page.getByRole("button", { name: "Roll back", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Roll back", exact: true }).click()
  await expect.poll(() => posts.length).toBe(1)
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Actors", exact: true })
    .click()
  await expect(page).toHaveURL(`${origin}/actors`)
  await release()
  await expect(
    page.getByRole("status").filter({ hasText: "Rollback to bbbbbbb: Previous release" }),
  ).toBeVisible()
  await expect(page).toHaveURL(`${origin}/actors`)
})

test("shows not found for an unknown deployment id instead of another deployment", async ({
  page,
}) => {
  const lists: Array<string> = []
  await signIn(page)
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/projects/runtime_project/deployments") {
      lists.push(path)
      return route.fulfill({ json: { items: [liveDeployment], nextCursor: null } })
    }
    if (/\/deployments\/[^/]+$/.test(path)) return route.fulfill(deploymentNotFound(path))
    return controlPlane(route)
  })
  await page.goto(`${origin}/deployments/deploy_missing`)
  await expect(page.getByRole("heading", { name: "This page drifted off" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Current release" })).toHaveCount(0)
  expect(lists).toEqual([])
})

/** An inspector as the API serves it: what the runner's inspector does not hold is null. */
const unreportedInspector = (count: number) => ({
  address: "Counter/hits",
  state: { count },
  turn: null,
  tables: null,
  receipts: [
    {
      commandId: "cmd_first",
      command: "Increment",
      result: "Success",
      caller: { kind: "user", subject: "user:runtime_user", source: null },
      at: null,
      expiresAt: "2026-10-05T12:00:00Z",
      replayed: false,
    },
  ],
  events: [
    { name: "Incremented", cursor: "1", emittedAt: "2026-10-04T12:00:00Z", subscribers: null },
  ],
  jobs: [],
  connections: { sockets: null, feedCursor: "1" },
  properties: {
    status: null,
    type: "Counter",
    generation: 1,
    runner: null,
    region: null,
    tenant: "runtime_org",
    mailboxDepth: null,
  },
  timeline: null,
})

test("shows a live inspector without the sample notice and its unreported fields as unknown", async ({
  page,
}) => {
  const jobs: Array<string> = []
  let sent = 0
  await signIn(page)
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Counter/hits"))
      return route.fulfill({ json: unreportedInspector(3 + sent) })
    if (path.endsWith("/runtime/actors/Counter/hits/jobs")) jobs.push(path)
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sent += 1
      return route.fulfill({
        json: { commandId: "cmd_next", result: { count: 4 }, replayed: false },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Counter/hits`)
  await expect(page.getByRole("heading", { name: "Counter/hits" })).toBeVisible()
  await expect(page.getByText('"count": 3')).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  const properties = page.getByRole("complementary", { name: "Properties" })
  for (const [term, value] of [
    ["Status", "—"],
    ["Generation", "1"],
    ["Turn", "—"],
    ["Runner", "—"],
    ["Region", "—"],
    ["Tenant", "runtime_org"],
    ["Mailbox", "—"],
    ["Sockets", "—"],
  ] as const)
    await expect(
      properties.locator("div", { has: page.getByRole("term").getByText(term, { exact: true }) }),
    ).toHaveText(`${term}${value}`)
  await expect(page.getByText("Activity isn’t reported")).toBeVisible()
  const inspectorTabs = page.getByRole("navigation", { name: "Inspector" })
  await expect(page.getByRole("button", { name: "Send command", exact: true })).toBeEnabled()

  await inspectorTabs.getByRole("link", { name: "Rows", exact: true }).click()
  await expect(page.getByText("Owned rows aren’t reported")).toBeVisible()
  await inspectorTabs.getByRole("link", { name: "Receipts", exact: true }).click()
  await expect(page.getByRole("table", { name: "Receipts" }).getByRole("row").nth(1)).toHaveText(
    "cmd_firstIncrementSuccessRuntime Operator—10-05 12:00",
  )
  await inspectorTabs.getByRole("link", { name: "Events", exact: true }).click()
  await expect(page.getByRole("table", { name: "Events" }).getByRole("row").nth(1)).toHaveText(
    "1Incremented10-04 12:00—",
  )
  await inspectorTabs.getByRole("link", { name: "Jobs", exact: true }).click()
  await expect(page.getByRole("table", { name: "Jobs" })).toContainText("No pending or dead jobs")
  expect(jobs).toEqual([])

  await inspectorTabs.getByRole("link", { name: "State", exact: true }).click()
  await page.getByRole("button", { name: "Send command", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Increment")
  await dialog.getByLabel("Payload", { exact: true }).fill("1")
  await dialog.getByRole("button", { name: "Send command", exact: true }).click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByText('"count": 4')).toBeVisible()
  expect(sent).toBe(1)
})

test("offers Send first command when inspection finds no actor, then inspects the actor it made", async ({
  page,
}) => {
  const sent: Array<unknown> = []
  await signIn(page)
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runtime/actors/Counter/hits"))
      return sent.length === 0
        ? route.fulfill({
            status: 404,
            contentType: "application/json",
            body: '{"_tag":"NotFound","resource":"actor","id":"Counter/hits"}',
          })
        : route.fulfill({ json: unreportedInspector(1) })
    if (path.endsWith("/runtime/commands") && route.request().method() === "POST") {
      sent.push(route.request().postDataJSON())
      return route.fulfill({
        json: { commandId: "cmd_first", result: { count: 1 }, replayed: false },
      })
    }
    return controlPlane(route)
  })
  await page.goto(`${origin}/actors/Counter/hits`)
  await expect(
    page.getByRole("heading", { name: "Counter/hits hasn’t received a command yet" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Send first command" }).click()
  const dialog = page.getByRole("dialog", { name: "Send a command" })
  await dialog.getByLabel("Command", { exact: true }).fill("Increment")
  await dialog.getByLabel("Payload", { exact: true }).fill("1")
  await dialog.getByRole("button", { name: "Send command", exact: true }).click()
  await expect(dialog.getByText("Committed — returned the actor’s result.")).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByText('"count": 1')).toBeVisible()
  await expect(page.getByRole("button", { name: "Send first command" })).toHaveCount(0)
  await expect(page.getByRole("note")).toHaveCount(0)
  expect(sent).toEqual([
    expect.objectContaining({ address: "Counter/hits", command: "Increment", payload: 1 }),
  ])
})

/** The runtime as the runners' durable views report it: counts are measured, rates and health are not. */
const durableRuntime = (route: Route) => {
  const path = new URL(route.request().url()).pathname
  const runtime = "/api/projects/runtime_project/environments/production/runtime"
  if (path === `${runtime}/overview`)
    return route.fulfill({
      json: {
        commands: null,
        actors: { awake: null, total: 2 },
        jobs: { inFlight: 1, donePerHour: null },
        deadLettersByJobType: [{ jobName: "Charge", count: 1 }],
        throughput: null,
        p99: null,
        health: {
          runners: null,
          databaseCpuPercent: null,
          maxMailbox: null,
          parkedSockets: null,
          outboxLagP99Ms: null,
          lastDeployAt: null,
        },
        recentDeployments: null,
      },
    })
  if (path === "/api/projects/runtime_project/deployments")
    return route.fulfill({ json: { items: [liveDeployment], nextCursor: null } })
  if (path === `${runtime}/actor-types`)
    return route.fulfill({
      json: [
        {
          name: "Counter",
          commands: null,
          instances: 2,
          awake: null,
          commandsPerSecond: null,
          p99Ms: null,
          maxMailbox: null,
        },
      ],
    })
  if (path === `${runtime}/commands`)
    return route.fulfill({
      json: {
        items: [
          {
            commandId: "v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715",
            at: null,
            durationMs: null,
            address: "Counter/hits",
            command: "Increment",
            caller: { kind: "user", subject: "user:runtime_user", source: null },
            payloadPreview: null,
            outcome: "ok",
            errorTag: null,
          },
          {
            commandId: "cmd_key",
            at: null,
            durationMs: null,
            address: "Counter/misses",
            command: "Increment",
            caller: { kind: "user", subject: "api-key:key_runtime_ci", source: null },
            payloadPreview: null,
            outcome: "error",
            errorTag: "Overflow",
          },
        ],
        nextCursor: null,
      },
    })
  if (path === `${runtime}/jobs`)
    return route.fulfill({
      json: {
        queued: 0,
        running: null,
        retrying: 0,
        dead: 1,
        byType: [{ jobName: "Charge", done: null, retried: 0, dead: 1, p99Ms: null }],
        throughput: null,
      },
    })
  if (path === `${runtime}/dead-letters`)
    return route.fulfill({
      json: {
        items: [
          {
            id: "dl_runtime",
            jobName: "Charge",
            jobId: "job_runtime",
            actor: "Counter/hits",
            attempts: 3,
            lastError: "declined",
            since: "2026-10-03T11:00:00Z",
          },
        ],
        nextCursor: null,
      },
    })
  if (path === `${runtime}/workflows`)
    return route.fulfill({
      json: {
        items: [
          {
            id: "wf_done",
            name: "Fulfil",
            actor: "Counter/hits",
            step: null,
            waitingFor: null,
            startedAt: "2026-10-03T10:00:00Z",
            status: "completed",
          },
          {
            id: "wf_running",
            name: "Charge",
            actor: "Counter/misses",
            step: { index: 2, total: null, name: "pay" },
            waitingFor: null,
            startedAt: "2026-10-03T11:00:00Z",
            status: "running",
          },
        ],
        nextCursor: null,
      },
    })
  if (path === `${runtime}/timers`) return route.fulfill({ json: { pending: 0, nextFireAt: null } })
  return controlPlane(route)
}

const serveDurableRuntime = async (page: Page) => {
  await signIn(page)
  await page.route("**/api/**", durableRuntime)
}

const noUnknownWords = async (page: Page) => {
  await expect(page.getByRole("main")).not.toContainText(/null|NaN|undefined/)
}

test("overview reads unmeasured numbers as dashes and marks only the sample distribution", async ({
  page,
}) => {
  await serveDurableRuntime(page)
  await page.goto(origin)
  const main = page.getByRole("main")
  await expect(page.getByRole("region", { name: "Health" })).toContainText(
    /Runners\s*—\s*Database\s*—\s*Mailbox depth\s*—\s*Parked sockets\s*—\s*Outbox lag\s*—\s*Dead letters\s*1 need a decision/,
  )
  await expect(main).toContainText(/Commands \/ s\s*—/)
  await expect(main).toContainText(/Awake actors\s*—/)
  await expect(page.getByRole("region", { name: "Throughput" })).toContainText(
    "Throughput isn’t reported.",
  )
  await expect(page.getByRole("region", { name: "Turn latency", exact: true })).toContainText(
    "Turn latency isn’t reported.",
  )
  await expect(page.getByRole("table", { name: "Recent deploys" })).toContainText("Current release")
  await expect(page.getByRole("note")).toHaveCount(1)
  await expect(
    page.getByRole("region", { name: "Turn latency distribution" }).getByRole("note"),
  ).toHaveText("Sample data — this part isn’t connected yet.")
  await expect(page.getByRole("button", { name: "Time range: last 24 hours" })).toBeDisabled()
  await noUnknownWords(page)
})

test("command log shows short ids and callers beside unrecorded times", async ({ page }) => {
  await serveDurableRuntime(page)
  await page.goto(`${origin}/commands`)
  const table = page.getByRole("table", { name: "Committed turns, newest first" })
  const own = table.getByRole("row").filter({ hasText: "Counter/hits" })
  await expect(own).toContainText(
    /—\s*5979a62a\s*—\s*Counter\/hits\s*Increment\s*Runtime Operator\s*ok/,
  )
  await expect(
    own.getByTitle("v1.1791099825418.1791186225418.5979a62a-ca7e-48a3-82b3-fff071bcd715"),
  ).toHaveText("5979a62a")
  await expect(table.getByRole("row").filter({ hasText: "Counter/misses" })).toContainText(
    /cmd_key\s*—\s*Counter\/misses\s*Increment\s*API key …ime_ci\s*Overflow/,
  )
  await expect(
    page.getByText("Live updates aren’t connected yet. Showing the latest fetched commands."),
  ).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  await noUnknownWords(page)
})

test("jobs keep live dead letters read-only with one reason and unmeasured totals as dashes", async ({
  page,
}) => {
  await serveDurableRuntime(page)
  await page.goto(`${origin}/jobs`)
  await expect(page.getByRole("main")).toContainText(/Running\s*—/)
  await expect(page.getByRole("table", { name: "Jobs by type" })).toContainText(
    /Charge\s*—\s*0\s*1\s*—/,
  )
  await expect(page.getByRole("region", { name: "Throughput" })).toContainText(
    "Job throughput isn’t reported.",
  )
  await expect(page.getByText("Retry and discard aren’t available yet.")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Retry job_runtime" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Discard job_runtime" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Retry all" })).toBeDisabled()
  await expect(page.getByRole("link", { name: "Counter/hits" })).toBeVisible()
  await expect(page.getByRole("note")).toHaveCount(0)
  await noUnknownWords(page)
})

test("workflows show unknown steps plainly and mark only the sample schedules", async ({
  page,
}) => {
  await serveDurableRuntime(page)
  await page.goto(`${origin}/workflows`)
  const runs = page.getByRole("table", { name: "Workflows" })
  await expect(runs.getByRole("row").filter({ hasText: "Fulfil" })).toContainText(
    /Counter\/hits\s*—\s*—/,
  )
  await expect(runs.getByRole("row").filter({ hasText: "Charge" })).toContainText("pay · step 2")
  await expect(page.getByRole("note")).toHaveCount(1)
  await expect(page.getByRole("region", { name: "Schedules" }).getByRole("note")).toHaveText(
    "Sample data — this part isn’t connected yet.",
  )
  await expect(page.getByRole("main")).toContainText(/Schedules\s*—/)
  await expect(runs.getByRole("link")).toHaveCount(2)
  await noUnknownWords(page)
})
