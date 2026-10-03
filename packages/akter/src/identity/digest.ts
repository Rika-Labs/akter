import { sha256 } from "@noble/hashes/sha2.js"

/** A browser-safe SHA-256 accumulator, with Bun's native implementation when available. */
export const sha256Hasher = () =>
  globalThis.Bun === undefined ? sha256.create() : new globalThis.Bun.CryptoHasher("sha256")

/** Stable SHA-256 bytes shared by runtime, content references and fleet definitions. */
export const sha256Bytes = (bytes: Uint8Array) => sha256Hasher().update(bytes).digest()
