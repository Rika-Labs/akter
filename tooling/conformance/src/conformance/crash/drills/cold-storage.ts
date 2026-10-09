import { CreateBucketCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3"
import { Config, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ColdStorage } from "../../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { freePort, until } from "./failover.ts"

/** A private, disposable S3 server; no shared bucket, volume, or credentials are used. */
export const minio = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const image = yield* Config.String("COLD_MINIO_IMAGE").pipe(
    Config.withDefault(
      "cgr.dev/chainguard/minio@sha256:4b862594d23cb20ae0fbeb93311ed312a5b566ecba2293220b204c89ef3c1fe2",
    ),
  )
  const port = yield* freePort
  const docker = (args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("docker", args)).pipe(Effect.map((output) => output.trim()))
  const id = yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--user",
      "0",
      "--publish",
      `127.0.0.1:${port}:9000`,
      "--env",
      "MINIO_ROOT_USER=cold-test",
      "--env",
      "MINIO_ROOT_PASSWORD=disposable-cold-test",
      "--entrypoint",
      "/usr/bin/minio",
      image,
      "server",
      "/data",
    ]),
    (id) => Effect.ignore(docker(["rm", "--force", "--volumes", id])),
  )
  const endpoint = `http://127.0.0.1:${port}`
  const config = {
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: { accessKeyId: "cold-test", secretAccessKey: "disposable-cold-test" },
    maxAttempts: 1,
  }
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new S3Client(config)),
    (client) => Effect.sync(() => client.destroy()),
  )
  yield* until(
    Effect.tryPromise(() => client.send(new ListBucketsCommand({}))).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    "the disposable cold object server",
    "30 seconds",
  )
  const bucket = "cold-test"
  yield* Effect.tryPromise(() => client.send(new CreateBucketCommand({ Bucket: bucket })))
  const store = yield* ColdStorage.s3({ ...config, bucket })
  return { store, config, bucket, docker, id }
})
