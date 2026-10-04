import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto"
import { Clock, DateTime, Duration, Effect, Redacted } from "effect"
import { identity, type RunnerCredentials } from "./credentials.ts"

const tlv = (tag: number, ...parts: ReadonlyArray<Uint8Array>) => {
  const body = Buffer.concat(parts)
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : (() => {
          const bytes: Array<number> = []

          for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256))
            bytes.unshift(rest % 256)

          return Buffer.from([0x80 | bytes.length, ...bytes])
        })()

  return Buffer.concat([Buffer.from([tag]), length, body])
}

const sequence = (...parts: ReadonlyArray<Uint8Array>) => tlv(0x30, ...parts)

const oid = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number)
  const bytes = [first! * 40 + second!]

  for (const arc of rest) {
    const groups = [arc & 0x7f]

    for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift(0x80 | (value & 0x7f))
    bytes.push(...groups)
  }

  return tlv(0x06, Buffer.from(bytes))
}

const integer = (bytes: Uint8Array) =>
  tlv(0x02, (bytes[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)

const time = (millis: number) => {
  const text = DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/[-:T]|\.\d+/gu, "")

  return Number(text.slice(0, 4)) < 2050
    ? tlv(0x17, Buffer.from(text.slice(2)))
    : tlv(0x18, Buffer.from(text))
}

const name = (common: string) =>
  sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(common)))))

const extension = (id: string, critical: boolean, value: Uint8Array) =>
  sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value))

const keyId = (key: KeyObject) =>
  createHash("sha1")
    .update(key.export({ type: "spki", format: "der" }))
    .digest()

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"))

/**
 * A DER X.509 v3 certificate for `subject`, signed with ECDSA P-256 and
 * SHA-256 by `issuer`. The serial is random, positive and minimally encoded,
 * because strict parsers such as BoringSSL reject a leading zero byte; key identifiers let
 * TLS stacks tell apart two authorities that share a name during a rotation.
 */
const build = (options: {
  readonly subject: string
  readonly issuer: string
  readonly publicKey: KeyObject
  readonly signer: KeyObject
  readonly notBefore: number
  readonly notAfter: number
  readonly extensions: ReadonlyArray<Uint8Array>
}) => {
  const serial = randomBytes(16)
  serial[0] = (serial[0]! & 0x3f) | 0x40

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(options.issuer),
    sequence(time(options.notBefore), time(options.notAfter)),
    name(options.subject),
    options.publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, sequence(...options.extensions)),
  )

  const der = sequence(
    tbs,
    ECDSA_SHA256,
    tlv(0x03, Buffer.from([0]), sign("sha256", tbs, options.signer)),
  )

  return `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/gu)!
    .join("\n")}\n-----END CERTIFICATE-----\n`
}

const pem = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString()

const SKEW = 5 * 60 * 1000

/** Options for one runner certificate. */
export interface IssueOptions {
  readonly deployment: string
  /** Default 90 days. */
  readonly validFor?: Duration.Input
  /** Default five minutes before now, so a peer whose clock runs behind accepts it at once. */
  readonly notBefore?: DateTime.DateTime
}

/**
 * A certificate authority that issues runner certificates for development
 * stacks and tests. Hosted and production deployments issue from a managed
 * authority instead, whose key never sits in a process's memory.
 */
export interface RunnerAuthority {
  /** The authority's own certificate, PEM: what every runner of its deployments trusts. */
  readonly certificate: string
  readonly key: Redacted.Redacted<string>
  /** A fresh key and certificate for one deployment's runners, with this authority as `ca`. */
  readonly issue: (options: IssueOptions) => Effect.Effect<RunnerCredentials>
}

const authority = (certificate: string, signer: KeyObject): RunnerAuthority => {
  const issuer = new X509Certificate(certificate).subject.replace(/^CN=/u, "")
  const issuerId = keyId(createPublicKey(signer))

  return {
    certificate,
    key: Redacted.make(pem(signer)),
    issue: (options) =>
      Effect.gen(function* () {
        const uri = identity(options.deployment)
        const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
        const notBefore =
          options.notBefore === undefined
            ? (yield* Clock.currentTimeMillis) - SKEW
            : DateTime.toEpochMillis(options.notBefore)

        return {
          ca: certificate,
          certificate: build({
            subject: `akter runner ${options.deployment}`,
            issuer,
            publicKey: pair.publicKey,
            signer,
            notBefore,
            notAfter:
              notBefore +
              Duration.toMillis(Duration.fromInputUnsafe(options.validFor ?? "90 days")),
            extensions: [
              extension("2.5.29.19", true, sequence()),
              extension("2.5.29.15", true, tlv(0x03, Buffer.from([7, 0x80]))),
              extension(
                "2.5.29.37",
                false,
                sequence(oid("1.3.6.1.5.5.7.3.1"), oid("1.3.6.1.5.5.7.3.2")),
              ),
              extension("2.5.29.17", false, sequence(tlv(0x86, Buffer.from(uri)))),
              extension("2.5.29.14", false, tlv(0x04, keyId(pair.publicKey))),
              extension("2.5.29.35", false, sequence(tlv(0x80, issuerId))),
            ],
          }),
          key: Redacted.make(pem(pair.privateKey)),
        }
      }),
  }
}

/** Creates and restores development certificate authorities for runner peering. */
export const RunnerAuthority = {
  /**
   * A new authority with a fresh P-256 key. Its name carries a random suffix
   * so an incoming and an outgoing authority never share a name.
   */
  make: (options?: { readonly name?: string; readonly validFor?: Duration.Input }) =>
    Effect.gen(function* () {
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
      const subject = `${options?.name ?? "akter runner authority"} ${randomBytes(4).toString("hex")}`
      const notBefore = (yield* Clock.currentTimeMillis) - SKEW

      return authority(
        build({
          subject,
          issuer: subject,
          publicKey: pair.publicKey,
          signer: pair.privateKey,
          notBefore,
          notAfter:
            notBefore +
            Duration.toMillis(Duration.fromInputUnsafe(options?.validFor ?? "3650 days")),
          extensions: [
            extension("2.5.29.19", true, sequence(tlv(0x01, Buffer.from([0xff])))),
            extension("2.5.29.15", true, tlv(0x03, Buffer.from([1, 0x06]))),
            extension("2.5.29.14", false, tlv(0x04, keyId(pair.publicKey))),
          ],
        }),
        pair.privateKey,
      )
    }),
  /**
   * An authority saved earlier, so runners started before and after a
   * restart keep trusting each other. Refuses a key that does not match the
   * certificate, or a certificate that is not an authority.
   */
  from: (options: { readonly certificate: string; readonly key: Redacted.Redacted<string> }) =>
    Effect.sync(() => {
      const parsed = new X509Certificate(options.certificate)
      const signer = createPrivateKey(Redacted.value(options.key))

      if (!parsed.ca || !parsed.checkPrivateKey(signer))
        throw new Error("Runner authority needs a CA certificate and its matching key")

      return authority(options.certificate, signer)
    }),
}
