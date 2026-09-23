import { Schema } from "effect"

export const TurboReport = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        hash: Schema.String,
        command: Schema.String,
        dependencies: Schema.Array(Schema.String),
        resolvedTaskDefinition: Schema.Struct({ cache: Schema.Boolean }),
      }),
    ),
  }),
)
