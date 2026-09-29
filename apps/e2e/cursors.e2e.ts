import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

/**
 * The presence and cursors page in examples/chat/src/web, served by serve.ts on a fresh in-memory database.
 */
const CHAT = "http://127.0.0.1:3003"

/**
 * Each test uses its own document, so tests share the server without sharing state.
 */
const docOf = (name: string) => `${name}-${randomUUID()}`

/**
 * The same page written twice: over the Promise client, and with @durable-actors/react.
 */
for (const [flavor, prefix] of [
  ["Promise client", "cursors"],
  ["React", "react/cursors"],
] as const) {
  test(`${flavor}: two pages see each other's cursor move, and one leave`, async ({ browser }) => {
    const doc = docOf("doc")
    const alice = await (await browser.newContext()).newPage()
    const bob = await (await browser.newContext()).newPage()

    await alice.goto(`${CHAT}/${prefix}/${doc}?user=alice`)
    await expect(alice.getByTestId("connection-status")).toHaveText("open")

    await bob.goto(`${CHAT}/${prefix}/${doc}?user=bob`)
    await expect(bob.getByTestId("connection-status")).toHaveText("open")
    await expect(alice.getByTestId("here")).toHaveText("2")
    await expect(bob.getByTestId("here")).toHaveText("2")

    const stageAt = async (page: typeof alice) => (await page.getByTestId("stage").boundingBox())!

    const alicebox = await stageAt(alice)
    await alice.mouse.move(alicebox.x + 100, alicebox.y + 80)
    await alice.mouse.move(alicebox.x + 200, alicebox.y + 120, { steps: 5 })

    const seenByBob = bob.getByTestId("cursor")
    await expect(seenByBob).toHaveCount(1)
    await expect(seenByBob).toHaveAttribute("data-user", "alice")
    await expect(seenByBob).toHaveAttribute("data-x", "200")
    await expect(seenByBob).toHaveAttribute("data-y", "120")

    const bobbox = await stageAt(bob)
    await bob.mouse.move(bobbox.x + 300, bobbox.y + 40)

    const seenByAlice = alice.getByTestId("cursor")
    await expect(seenByAlice).toHaveCount(1)
    await expect(seenByAlice).toHaveAttribute("data-user", "bob")
    await expect(seenByAlice).toHaveAttribute("data-x", "300")
    await expect(seenByAlice).toHaveAttribute("data-y", "40")

    await alice.mouse.move(alicebox.x + 420, alicebox.y + 260)
    await expect(seenByBob).toHaveAttribute("data-x", "420")
    await expect(seenByBob).toHaveAttribute("data-y", "260")

    await alice.screenshot({ path: test.info().outputPath(`cursors-${flavor}.png`) })

    await bob.context().close()
    await expect(alice.getByTestId("cursor")).toHaveCount(0)
    await expect(alice.getByTestId("here")).toHaveText("1")
    await alice.context().close()
  })

  test(`${flavor}: a page that opens late sees where the others already are`, async ({
    browser,
  }) => {
    const doc = docOf("late")
    const alice = await (await browser.newContext()).newPage()
    const bob = await (await browser.newContext()).newPage()

    await alice.goto(`${CHAT}/${prefix}/${doc}?user=alice`)
    await expect(alice.getByTestId("connection-status")).toHaveText("open")

    const box = (await alice.getByTestId("stage").boundingBox())!
    await alice.mouse.move(box.x + 150, box.y + 90)
    await alice.mouse.move(box.x + 160, box.y + 95)

    await bob.goto(`${CHAT}/${prefix}/${doc}?user=bob`)

    const seen = bob.getByTestId("cursor")
    await expect(seen).toHaveAttribute("data-user", "alice")
    await expect(seen).toHaveAttribute("data-x", "160")
    await expect(seen).toHaveAttribute("data-y", "95")

    await alice.context().close()
    await bob.context().close()
  })
}
