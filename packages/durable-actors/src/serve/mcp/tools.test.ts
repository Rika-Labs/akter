import { Effect, Exit, Schema } from "effect"
import { expect, it } from "vitest"
import { Actor } from "../../index.ts"
import { descriptorOf } from "../../actor/descriptor.ts"
import { mcpTools } from "./tools.ts"

const Post = Actor.command("Post", { input: Schema.Struct({ text: Schema.String }) })

const Room = Actor.make("Room", { key: Schema.String, api: { Post } })

const definition = descriptorOf(Room)!.served

const json = (schema: Schema.JsonObject) => ({ content: { "application/json": { schema } } })

const document = {
  paths: {
    "/api/command-ids": {
      post: { responses: { "200": json({ $ref: "#/components/schemas/Minted" }) } },
    },
    "/api/actors/Room/{id}/Post": {
      post: {
        parameters: [
          { name: "id", in: "path" },
          { name: "idempotency-key", in: "header", schema: { description: "the id" } },
        ],
        requestBody: { required: true, ...json({ $ref: "#/components/schemas/Message" }) },
        responses: { "200": json({ $ref: "#/components/schemas/Reply" }) },
      },
    },
  },
  components: {
    schemas: {
      Minted: { type: "object", properties: { commandId: { type: "string" } } },
      Message: { type: "object", properties: { author: { $ref: "#/components/schemas/Author" } } },
      Author: { type: "object", properties: { name: { type: "string" } } },
      Reply: { type: "array", items: { $ref: "#/components/schemas/Author" } },
      Unused: { type: "string" },
    },
  },
}

it("moves every schema a tool references, and the ones those reference, into the tool's own $defs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tools = yield* mcpTools({ document, basePath: "/api", definitions: [definition] })
      const post = tools.find((tool) => tool.name === "Room.Post")!

      expect(post.descriptor["inputSchema"]).toEqual({
        type: "object",
        properties: {
          id: expect.objectContaining({ type: "string" }),
          commandId: { type: "string", description: "the id" },
          input: { $ref: "#/$defs/Message" },
        },
        required: ["id", "commandId", "input"],
        additionalProperties: false,
        $defs: {
          Message: { type: "object", properties: { author: { $ref: "#/$defs/Author" } } },
          Author: { type: "object", properties: { name: { type: "string" } } },
        },
      })

      expect(post.descriptor["outputSchema"]).toEqual({
        $ref: "#/$defs/Reply",
        $defs: {
          Reply: { type: "array", items: { $ref: "#/$defs/Author" } },
          Author: { type: "object", properties: { name: { type: "string" } } },
        },
      })

      expect(post.structured).toBe(true)
      expect(post.input).toBe("required")
    }),
  ))

it("derives the command id tool from the mint operation and gives it no arguments", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const [mint] = yield* mcpTools({ document, basePath: "/api", definitions: [definition] })

      expect(mint?.name).toBe("durable.commandIds")
      expect(mint?.route).toBe(undefined)
      expect([mint?.takesId, mint?.takesCommandId, mint?.input]).toEqual([false, false, "none"])

      expect(mint?.descriptor["inputSchema"]).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      })
    }),
  ))

it("dies at startup when a served member has no operation in the document", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* mcpTools({
        document: {
          ...document,
          paths: { "/api/command-ids": document.paths["/api/command-ids"] },
        },
        basePath: "/api",
        definitions: [definition],
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  ))
