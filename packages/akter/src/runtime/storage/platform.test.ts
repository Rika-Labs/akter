import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { compress, decompress, routingKey } from "./codec.ts"

const json = '{"count":17,"label":"général🙂"}'

const bunFrame = Uint8Array.from([
  40, 181, 47, 253, 32, 36, 33, 1, 0, 123, 34, 99, 111, 117, 110, 116, 34, 58, 49, 55, 44, 34, 108,
  97, 98, 101, 108, 34, 58, 34, 103, 195, 169, 110, 195, 169, 114, 97, 108, 240, 159, 153, 130, 34,
  125,
])

describe("runtime storage interoperability", () => {
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
