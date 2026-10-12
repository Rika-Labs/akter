const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

const at = (words: Uint32Array, index: number): number => words[index] ?? 0

const encoder = new TextEncoder()

/**
 * SHA-256 of UTF-8 text, computed synchronously so that `ctx.id()` and derived command ids can be
 * produced inside a synchronous action on every runtime, with the same bytes `Crypto.digest`
 * would return.
 */
const sha256 = (text: string): Uint8Array => {
  const message = encoder.encode(text)
  const length = message.length
  const blocks = Math.floor((length + 9 + 63) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000))
  view.setUint32(padded.length - 4, (length << 3) >>> 0)
  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = at(w, i - 15)
      const w2 = at(w, i - 2)
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0
    }
    let a = at(hash, 0)
    let b = at(hash, 1)
    let c = at(hash, 2)
    let d = at(hash, 3)
    let e = at(hash, 4)
    let f = at(hash, 5)
    let g = at(hash, 6)
    let h = at(hash, 7)
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          at(K, i) +
          at(w, i)) >>>
        0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, h]
    next.forEach((value, index) => {
      hash[index] = (at(hash, index) + value) >>> 0
    })
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, at(hash, i))
  return out
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Synchronous SHA-256 for ids and payload digests. */
export const Digest = {
  sha256,
  hex: (text: string): string => hex(sha256(text)),
  bytesToHex: hex,
}
