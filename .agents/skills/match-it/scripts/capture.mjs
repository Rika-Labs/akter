import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { measurementSource } from "./measure.mjs"

const [session, configPath, directory] = process.argv.slice(2)
if (process.argv.length !== 5 || !session?.trim() || !isAbsolute(directory))
  throw new Error("Usage: node capture.mjs EXISTING_SESSION config.json /absolute/new-directory")
const configText = readFileSync(configPath, "utf8"),
  source = measurementSource(JSON.parse(configText))
const invoke = (...args) => {
  const child = spawnSync("agent-browser", ["--session", session, "--pin-tab", "--json", ...args], {
    encoding: "utf8",
    input: source,
    timeout: 35000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (child.error || child.status !== 0)
    throw new Error(`Browser ${args[0]} failed; capture is incomplete`)
  const response = JSON.parse(child.stdout)
  if (
    !response.success ||
    response.data?.lifecycle?.launched ||
    response.data?.lifecycle?.relaunchedBrowser ||
    response.data?.lifecycle?.restartedBackground
  )
    throw new Error("Browser failed or changed lifecycle; capture is incomplete")
  return response.data
}
const sessions = invoke("session", "list").sessions
if (!Array.isArray(sessions) || !sessions.includes(session))
  throw new Error("Session must already be active")
const info = invoke("session", "info")
if (!info.active || info.runtime?.restoreStatus !== "not_configured")
  throw new Error("Use an isolated session without auth restore")
const activeTab = () => {
  const tabs = invoke("tab", "list").tabs.filter((tab) => tab.active)
  if (tabs.length !== 1 || !tabs[0].targetId) throw new Error("Expected one active pinned target")
  return tabs[0].targetId
}
const targetId = activeTab(),
  before = invoke("eval", "--stdin").result
if (before?.schema !== 1) throw new Error("Measurement did not return a capture")
mkdirSync(directory)
const image = join(directory, "capture.png")
invoke("screenshot", image)
const after = invoke("eval", "--stdin").result
if (
  activeTab() !== targetId ||
  JSON.stringify(before) !== JSON.stringify(after) ||
  !existsSync(image)
)
  throw new Error("Observations changed around screenshot; capture is incomplete")
const digest = (value) => createHash("sha256").update(value).digest("hex")
writeFileSync(join(directory, "measurement.json"), JSON.stringify(before, null, 2), { flag: "wx" })
writeFileSync(
  join(directory, "complete.json"),
  JSON.stringify(
    {
      targetId,
      configSha256: digest(configText),
      screenshotSha256: digest(readFileSync(image)),
      measurementSha256: digest(readFileSync(join(directory, "measurement.json"))),
      createdAt: new Date().toISOString(),
      consistency:
        "Equal observations bracketing a viewport screenshot; not atomic or continuous evidence",
    },
    null,
    2,
  ),
  { flag: "wx" },
)
console.log(join(directory, "complete.json"))
