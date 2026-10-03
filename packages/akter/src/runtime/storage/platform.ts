import { zstdCompressSync, zstdDecompressSync } from "node:zlib"

const bun = globalThis.Bun

const xxhash = bun === undefined ? (await import("@node-rs/xxhash")).xxh3.xxh64 : bun.hash.xxHash3

/** Preserves persisted xxHash3 routing keys on both supported runtimes. */
export const hash64 = (text: string): bigint => xxhash(text)

/** Uses each runtime's native zstd implementation without changing the stored format. */
export const compressBytes = (bytes: Uint8Array): Uint8Array =>
  bun === undefined ? zstdCompressSync(bytes) : bun.zstdCompressSync(bytes)

/** Reads zstd frames written by either runtime. */
export const decompressBytes = (bytes: Uint8Array): Uint8Array =>
  bun === undefined ? zstdDecompressSync(bytes) : bun.zstdDecompressSync(bytes)
