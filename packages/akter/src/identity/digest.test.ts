import { expect, it } from "vitest"
import { sha256Bytes, sha256Hasher } from "./digest.ts"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

it("keeps content and definition hashes on SHA-256 across chunk boundaries", () => {
  expect(hex(sha256Bytes(new Uint8Array()))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
  const hasher = sha256Hasher()
  hasher.update(new TextEncoder().encode("a"))
  hasher.update(new TextEncoder().encode("bc"))
  expect(hex(hasher.digest())).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
  expect(hex(sha256Bytes(new TextEncoder().encode("abc")))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
})
