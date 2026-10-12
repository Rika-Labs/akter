import { readFileSync } from "node:fs"
import { BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { Config, Effect } from "effect"

/** Creates the recipe's bucket on its MinIO once; a bucket that already exists is left as it is. */
const program = Effect.gen(function* () {
  const bucket = yield* Config.String("S3_BUCKET")
  const client = new S3Client({
    region: yield* Config.String("S3_REGION").pipe(Config.withDefault("us-east-1")),
    endpoint: yield* Config.String("S3_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: yield* Config.String("S3_ACCESS_KEY_ID"),
      secretAccessKey: readFileSync("/run/secrets/s3-secret-access-key", "utf8").trim(),
    },
  })
  yield* Effect.tryPromise(() => client.send(new CreateBucketCommand({ Bucket: bucket }))).pipe(
    Effect.catchIf(
      (error) => error.cause instanceof BucketAlreadyOwnedByYou,
      () => Effect.void,
    ),
    Effect.ensuring(Effect.sync(() => client.destroy())),
  )
})

await Effect.runPromise(program)
