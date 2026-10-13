import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, Option, Predicate, Random } from "effect"
import { engineConformance } from "../../../../tooling/conformance/src/conformance/engine.ts"
import { storeConformance } from "../../../../tooling/conformance/src/conformance/store.ts"
import { StorageUnavailable } from "./errors.ts"
import { s3Bucket } from "./s3.ts"

/**
 * `TEST_S3_URL` names an S3-compatible endpoint, its credentials and a bucket
 * as `http://<access key>:<secret>@<host>:<port>/<bucket>`, such as the MinIO
 * service in `packages/akter/compose.yaml`; the bucket is created if missing
 * and each scenario gets a fresh key prefix in it.
 */
const target = Effect.gen(function* () {
  const url = new URL(yield* Config.String("TEST_S3_URL"))
  const options = {
    endpoint: `${url.protocol}//${url.host}`,
    bucket: url.pathname.replace(/^\/+|\/+$/gu, ""),
    credentials: {
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
    },
  }
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new S3Client({
          region: "us-east-1",
          endpoint: options.endpoint,
          forcePathStyle: true,
          credentials: options.credentials,
        }),
    ),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  yield* Effect.tryPromise(() =>
    client.send(new CreateBucketCommand({ Bucket: options.bucket })),
  ).pipe(
    Effect.catchIf(
      (error) =>
        Predicate.hasProperty(error.cause, "name") &&
        (error.cause.name === "BucketAlreadyOwnedByYou" ||
          error.cause.name === "BucketAlreadyExists"),
      () => Effect.void,
    ),
  )
  return options
})

storeConformance({
  name: "an S3-compatible bucket (TEST_S3_URL)",
  namespace: Effect.map(
    Effect.all([
      target,
      Random.nextIntBetween(0, 0xffff_ffff),
      Random.nextIntBetween(0, 0xffff_ffff),
    ]),
    ([options, high, low]) =>
      s3Bucket({ ...options, prefix: `conformance/${high.toString(16)}-${low.toString(16)}/` }),
  ),
})

engineConformance({
  name: "an S3-compatible bucket (TEST_S3_URL)",
  location: Effect.gen(function* () {
    const options = yield* target
    const high = yield* Random.nextIntBetween(0, 0xffff_ffff)
    const low = yield* Random.nextIntBetween(0, 0xffff_ffff)
    const prefix = `engine-conformance/${high.toString(16)}-${low.toString(16)}/`
    return {
      bucket: s3Bucket({ ...options, prefix }),
      env: {
        AKTER_CONFORMANCE_S3_URL: yield* Config.String("TEST_S3_URL"),
        AKTER_CONFORMANCE_S3_PREFIX: prefix,
      },
    }
  }),
})

/**
 * An S3 stand-in that answers a conditional create with 412 and then drops the
 * connection's next request unanswered, as MinIO RELEASE.2025-09-07 does: it
 * closes the kept-alive connection without saying so. A plain PUT of
 * `refused` is answered 412 as a provider may for a content key. Other
 * requests succeed.
 */
const droppingServer = Effect.acquireRelease(
  Effect.callback<{
    readonly port: number
    readonly arrivals: Array<string>
    readonly close: () => void
  }>((resume) => {
    const arrivals: Array<string> = []
    const dropping = new Set<number>()
    const server = createServer((request, response) => {
      const connection = request.socket.remotePort ?? 0
      const path = new URL(request.url ?? "/", "http://store").pathname
      arrivals.push(`${request.method} ${path}`)
      if (dropping.has(connection)) {
        request.socket.destroy()
        return
      }
      request.resume()
      request.on("end", () => {
        if (request.method === "PUT" && path === "/store/refused") {
          response
            .writeHead(412, { "content-type": "application/xml" })
            .end("<Error><Code>PreconditionFailed</Code></Error>")
          return
        }
        if (request.method === "PUT" && request.headers["if-none-match"] === "*") {
          response.on("finish", () => dropping.add(connection))
          response
            .writeHead(412, { "content-type": "application/xml" })
            .end("<Error><Code>PreconditionFailed</Code></Error>")
          return
        }
        response.writeHead(200, { etag: '"stored"' }).end(request.method === "GET" ? "stored" : "")
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = server.address()
      resume(
        Predicate.isObject(address) &&
          Predicate.hasProperty(address, "port") &&
          Predicate.isNumber(address.port)
          ? Effect.succeed({
              port: address.port,
              arrivals,
              close: () => {
                server.closeAllConnections()
                server.close()
              },
            })
          : Effect.die(new Error("the stand-in server has no port")),
      )
    })
  }),
  (server) => Effect.sync(server.close),
)

describe("s3Bucket", () => {
  it.effect(
    "resends a read, never a write, whose kept-alive connection the server dropped (rejects failing the read-back after a 412, and resending a write of unknown outcome)",
    () =>
      Effect.gen(function* () {
        const server = yield* droppingServer
        const bucket = yield* s3Bucket({
          bucket: "store",
          endpoint: `http://127.0.0.1:${server.port}`,
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
        })
        const decoder = new TextDecoder()

        expect(yield* bucket.create("a", new Uint8Array([1]))).toBe(false)
        expect(Option.map(yield* bucket.get("a"), (bytes) => decoder.decode(bytes))).toEqual(
          Option.some("stored"),
        )
        expect(yield* bucket.create("b", new Uint8Array([2]))).toBe(false)
        expect(yield* Effect.flip(bucket.put("c", new Uint8Array([3])))).toBeInstanceOf(
          StorageUnavailable,
        )
        expect(server.arrivals).toEqual([
          "PUT /store/a",
          "GET /store/a",
          "GET /store/a",
          "PUT /store/b",
          "PUT /store/c",
        ])
      }),
  )

  it.effect(
    "keeps a 412 on a plain write a failure the caller resolves (rejects reading every 412 as a condition that did not hold)",
    () =>
      Effect.gen(function* () {
        const server = yield* droppingServer
        const bucket = yield* s3Bucket({
          bucket: "store",
          endpoint: `http://127.0.0.1:${server.port}`,
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
        })
        const refused = yield* Effect.flip(bucket.put("refused", new Uint8Array([4])))
        expect(refused).toBeInstanceOf(StorageUnavailable)
        expect(refused.status).toBe(412)
        expect(server.arrivals).toEqual(["PUT /store/refused"])
      }),
  )
})
