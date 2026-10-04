import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { describe, expect, it } from "vitest"
import { compress, decompress, routingKey } from "./codec.ts"

const json = '{"count":17,"label":"général🙂"}'

const [{ spawnSync }, { mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import("node:child_process"),
  import("node:fs"),
  import("node:os"),
  import("node:path"),
])

const bunFrame = Uint8Array.from([
  40, 181, 47, 253, 32, 36, 33, 1, 0, 123, 34, 99, 111, 117, 110, 116, 34, 58, 49, 55, 44, 34, 108,
  97, 98, 101, 108, 34, 58, 34, 103, 195, 169, 110, 195, 169, 114, 97, 108, 240, 159, 153, 130, 34,
  125,
])

describe("runtime storage interoperability", () => {
  it("writes byte-identical routing keys, state frames and hashes in Bun and Node, then reads each other's persisted bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "akter-runtime-codec-"))
    const values = [
      "",
      json,
      JSON.stringify(Array.from({ length: 600 }, (_, count) => ({ count, label: "général🙂" }))),
    ]
    const script = `
      import { strict as assert } from "node:assert"
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
      import { compress, decompress, routingKey } from ${JSON.stringify(new URL("./codec.ts", import.meta.url).href)}
      import { sha256Bytes } from ${JSON.stringify(new URL("../../identity/digest.ts", import.meta.url).href)}
      const values = ${JSON.stringify(values)}
      const [mode, directory] = process.argv.slice(1)
      const manifest = values.map((value, index) => {
        const frame = compress(value)
        const key = routingKey({ ref: { tenant: "t\\u0000n", actor: 'A"b', id: '["x",1]' }, placement: "actor" }).toString()
        const hash = Buffer.from(sha256Bytes(new TextEncoder().encode(value))).toString("hex")
        if (mode === "write") {
          mkdirSync(directory, { recursive: true })
          writeFileSync(directory + "/" + index + ".zstd", frame)
        } else {
          assert.equal(decompress(readFileSync(directory + "/" + index + ".zstd")), value)
        }
        return { key, hash, frame: Buffer.from(frame).toString("hex") }
      })
      if (mode === "write") writeFileSync(directory + "/manifest.json", JSON.stringify(manifest))
      else assert.deepEqual(JSON.parse(readFileSync(directory + "/manifest.json", "utf8")), manifest)
      console.log(JSON.stringify(manifest))
    `
    const run = (runtime: string, mode: string, path: string) => {
      const child = spawnSync(runtime, ["--input-type=module", "-e", script, mode, path], {
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)

      return JSON.parse(child.stdout)
    }

    try {
      const bun = run("bun", "write", join(directory, "bun"))
      const node = run("node", "write", join(directory, "node"))
      expect(node).toEqual(bun)
      expect(bun).toEqual(
        values.map((value) => ({
          key: "-4555675029134783043",
          hash: bytesToHex(sha256(new TextEncoder().encode(value))),
          frame: expect.any(String),
        })),
      )
      expect(run("node", "read", join(directory, "bun"))).toEqual(bun)
      expect(run("bun", "read", join(directory, "node"))).toEqual(node)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reads preexisting Bun state frames and Node frames with the same encoding", () => {
    expect(decompress(bunFrame)).toBe(json)
    expect(decompress(zstdCompressSync(new TextEncoder().encode(json)))).toBe(json)
    expect(new TextDecoder().decode(zstdDecompressSync(compress(json)))).toBe(json)
    expect(() => decompress(Uint8Array.from([1, 2, 3]))).toThrow()
  })

  it("preserves signed xxHash3 placement keys across runtimes", () => {
    expect(
      routingKey({
        ref: { tenant: "t\u0000n", actor: 'A"b', id: '["x",1]' },
        placement: "actor",
      }),
    ).toBe(-4555675029134783043n)
    expect(
      routingKey({
        ref: { tenant: "🙂", actor: "Feed", id: "" },
        placement: "tenant",
      }),
    ).toBe(4426527016479877485n)
  })
})
