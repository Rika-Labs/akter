import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

const work = `${homedir()}/.capy/work`

/**
 * The two machine-wide slots and the run mutex use the same directories as
 * `~/.capy/work/akter-launch/heavy.sh` and the retired `local-ci.ts`, so all three exclude each
 * other. A slot is a directory created atomically with `mkdir` that holds its owner's pid, and a
 * directory whose owner no longer runs is reclaimed. Slot first, then mutex, is the order the
 * retired script used, which keeps a mixed old and new queue from deadlocking.
 */
const slots = [`${work}/akter-heavy-1`, `${work}/akter-heavy-2`]
const mutex = `${work}/akter-localci.lock`

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const ownerOf = (directory: string) => {
  try {
    return Number(readFileSync(`${directory}/pid`, "utf8").trim())
  } catch {
    return 0
  }
}

const take = (directory: string, description: string) => {
  try {
    mkdirSync(directory)
  } catch {
    const owner = ownerOf(directory)
    if (owner > 0 && !alive(owner)) rmSync(directory, { recursive: true, force: true })
    return false
  }
  writeFileSync(`${directory}/pid`, String(process.pid))
  writeFileSync(`${directory}/cmd`, `${process.cwd()}\n${description}\n`)
  return true
}

export async function acquire(description: string): Promise<() => void> {
  mkdirSync(work, { recursive: true })
  const held: string[] = []
  const release = () => {
    for (const directory of held.splice(0)) rmSync(directory, { recursive: true, force: true })
  }
  process.on("exit", release)
  for (const [directories, name] of [
    [slots, "heavy slot"],
    [[mutex], "verification run"],
  ] as const) {
    for (let waited = 0; ; waited += 5) {
      const taken = directories.find((directory) => take(directory, description))
      if (taken !== undefined) {
        held.push(taken)
        console.log(`local-verify: holding ${name} ${taken.split("/").pop()} after ${waited}s`)
        break
      }
      if (waited % 60 === 0) console.log(`local-verify: waiting for a ${name} (${waited}s)`)
      await Bun.sleep(5000)
    }
  }
  return release
}
