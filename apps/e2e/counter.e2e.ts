import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

/**
 * The counter example served by examples/counter/src/web/serve.ts, on a fresh in-memory database.
 */
const COUNTER = "http://127.0.0.1:3004"

/**
 * Each test uses its own counter, so tests share the server without sharing state.
 */
const counterOf = (name: string) => `${name}-${randomUUID()}`

/**
 * The same page written twice: over the Promise client, and with @durable-actors/react.
 */
for (const [flavor, prefix] of [
  ["Promise client", "counters"],
  ["React", "react/counters"],
] as const) {
  test(`${flavor}: shows increments, and a second tab sees them live`, async ({ browser }) => {
    const id = counterOf("live")
    const url = (user: string) => `${COUNTER}/${prefix}/${id}?user=${user}`
    const alice = await (await browser.newContext()).newPage()
    const bob = await (await browser.newContext()).newPage()

    await alice.goto(url("alice"))
    await expect(alice.getByTestId("user")).toHaveText("alice")
    await expect(alice.getByTestId("count")).toHaveText("0")

    await alice.getByTestId("increment").click()
    await expect(alice.getByTestId("count")).toHaveText("1")
    await alice.getByTestId("increment").click()
    await expect(alice.getByTestId("count")).toHaveText("2")

    /**
     * A tab opened later replays the counter's feed and shows where it stands.
     */
    await bob.goto(url("bob"))
    await expect(bob.getByTestId("count")).toHaveText("2")

    /**
     * Each tab's increments reach the other while both are open.
     */
    await bob.getByTestId("increment").click()
    await expect(alice.getByTestId("count")).toHaveText("3")
    await expect(bob.getByTestId("count")).toHaveText("3")

    await alice.getByTestId("increment").click()
    await expect(bob.getByTestId("count")).toHaveText("4")
    await expect(alice.getByTestId("count")).toHaveText("4")

    await bob.screenshot({ path: test.info().outputPath(`counter-${flavor}.png`) })
    await alice.context().close()
    await bob.context().close()
  })
}
