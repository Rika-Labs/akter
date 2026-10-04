import { isIP } from "node:net"

/**
 * What the edge may believe about a request's origin.
 *
 * `nlbOnly` is a deployment statement, not something a request can show: the
 * edge's network admits traffic only through an NLB that keeps the client's
 * source address, so the TCP peer of every connection is the host that
 * connected to the NLB. Only then is the peer meaningful, and only then is
 * `CF-Connecting-IP` believed, and only from a peer inside `cloudflare`.
 */
export interface TrustedProxies {
  readonly nlbOnly: boolean
  /** Cloudflare's published ranges. */
  readonly cloudflare: ReadonlyArray<string>
}

interface Address {
  readonly bits: 32 | 128
  readonly value: bigint
}

/** The hextets of an IPv6 text with its `::` expanded, or none for text `isIP` accepted but cannot be split. */
const hextets = (text: string) => {
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  let head = text

  if (embedded !== null) {
    const octets = embedded[2]!.split(".").map(Number)

    head = `${embedded[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }

  const [left = "", right, extra] = head.split("::")

  if (extra !== undefined) return undefined

  const front = left === "" ? [] : left.split(":")
  const back = right === undefined || right === "" ? [] : right.split(":")
  const fill = right === undefined ? 0 : 8 - front.length - back.length

  if (fill < 0 || (right === undefined && front.length !== 8)) return undefined

  return [...front, ...Array.from({ length: fill }, () => "0"), ...back]
}

/** An IPv4-mapped IPv6 address is its IPv4 address, so one range matches either spelling. */
const parse = (text: string): Address | undefined => {
  const family = text.includes("%") ? 0 : isIP(text)

  if (family === 4) {
    const value = text.split(".").reduce((sum, octet) => (sum << 8n) + BigInt(octet), 0n)

    return { bits: 32, value }
  }

  if (family !== 6) return undefined

  const parts = hextets(text)

  if (parts === undefined) return undefined

  const value = parts.reduce((sum, part) => (sum << 16n) + BigInt(`0x${part}`), 0n)

  return value >> 32n === 0xffffn ? { bits: 32, value: value & 0xffff_ffffn } : { bits: 128, value }
}

/** The address as the edge forwards it: IPv4-mapped IPv6 collapsed, otherwise as written. */
export const normalizeIp = (text: string) => {
  const parsed = parse(text)

  if (parsed === undefined) return undefined

  if (parsed.bits === 32 && isIP(text) === 6)
    return [24n, 16n, 8n, 0n].map((shift) => String((parsed.value >> shift) & 0xffn)).join(".")

  return text.toLowerCase()
}

const compile = (block: string) => {
  const [text = "", length, extra] = block.trim().split("/")
  const base = parse(text)

  if (base === undefined || extra !== undefined) return undefined

  const prefix = length === undefined ? base.bits : /^\d{1,3}$/u.test(length) ? Number(length) : -1

  if (prefix < 0 || prefix > base.bits) return undefined

  const shift = BigInt(base.bits - prefix)

  return { bits: base.bits, network: base.value >> shift, shift }
}

/**
 * Compiles CIDR blocks into a membership test. A block that does not parse is
 * a configuration mistake, so it throws rather than silently trusting less or
 * more than the operator wrote.
 */
export const cidrs = (blocks: ReadonlyArray<string>) => {
  const compiled = blocks.map((block) => {
    const entry = compile(block)

    if (entry === undefined) throw new Error(`Not an IP address or CIDR block: ${block}`)

    return entry
  })

  return (text: string) => {
    const address = parse(text)

    return (
      address !== undefined &&
      compiled.some(
        (entry) => entry.bits === address.bits && address.value >> entry.shift === entry.network,
      )
    )
  }
}

/**
 * Builds the client IP rule of the hosted edge.
 *
 * `CF-Connecting-IP` is only a claim by whoever sent it. The edge believes it
 * when `nlbOnly` is set and the TCP peer is a Cloudflare address. A peer
 * inside a VPC or NLB range proves nothing, so it is never trusted. Every
 * other peer is the client, whatever headers it sent, and so is a Cloudflare
 * peer that sent no valid `CF-Connecting-IP`.
 */
export const clientIps = (trusted: TrustedProxies) => {
  const viaCloudflare = trusted.nlbOnly ? cidrs(trusted.cloudflare) : () => false

  return (peer: string | undefined, headers: Headers) => {
    const address = peer === undefined ? undefined : normalizeIp(peer)

    if (address === undefined) return undefined

    if (!viaCloudflare(address)) return address

    const claimed = headers.get("cf-connecting-ip")?.trim()

    return (claimed === undefined ? undefined : normalizeIp(claimed)) ?? address
  }
}
