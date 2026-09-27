import { Effect, Schema, SchemaAST } from "effect"
import type { DeclaredError, MemberKind, ValueSchema } from "../members/command.ts"

/** A public member as a served endpoint sees it: wire schemas and the runtime's payload codec. */
export interface ServedMember {
  readonly kind: MemberKind
  readonly tag: string
  readonly input: ValueSchema
  readonly output: ValueSchema
  readonly errors: ReadonlyArray<DeclaredError>
  /** Decodes a JSON request body (`undefined` when empty) into the runtime payload. */
  readonly payload: (body: Schema.Json | undefined) => Effect.Effect<string, Schema.SchemaError>
  /** Status per declared error, in declaration order. */
  readonly failureStatus: (value: string) => Effect.Effect<number, Schema.SchemaError>
}

export interface ServedDefinition {
  readonly name: string
  readonly key: "keyed" | "singleton" | "minted"
  readonly decodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  /** `api` members only; `internal` commands are never served. */
  readonly members: ReadonlyArray<ServedMember>
  readonly deliveryMs: number
}

interface ServedOwner {
  readonly name: string
}

export const servedDefinitions = new WeakMap<ServedOwner, ServedDefinition>()

/** Statuses the served protocol assigns to framework outcomes; a declared failure can't claim one. */
const RESERVED_STATUSES: ReadonlySet<number> = new Set([401, 403, 409, 410, 413, 415, 429])

const RESERVED_TAGS: ReadonlySet<string> = new Set(["ActorError", "Defect"])

export const DECLARED_FAILURE_STATUS = 422

export const declaredStatus = (error: DeclaredError): number =>
  SchemaAST.resolveAt<number>("httpApiStatus")(error.ast) ?? DECLARED_FAILURE_STATUS

/** Rejects declared errors a served response could not tell apart from a framework one. */
export const checkDeclaredErrors = (member: {
  readonly tag: string
  readonly errors: ReadonlyArray<DeclaredError>
}) => {
  for (const error of member.errors) {
    const tag = SchemaAST.resolveIdentifier(error.ast)

    if (tag !== undefined && RESERVED_TAGS.has(tag))
      throw new Error(`${member.tag} declares an error tagged ${tag}, which is reserved`)

    const status = declaredStatus(error)

    if (!Number.isInteger(status) || status < 400 || status > 499 || RESERVED_STATUSES.has(status))
      throw new Error(`${member.tag} declares httpApiStatus ${status}; use an unreserved 4xx`)
  }
}

export interface ServedMemberSource {
  readonly member: {
    readonly kind: MemberKind
    readonly tag: string
    readonly input: ValueSchema
    readonly output: ValueSchema
    readonly errors: ReadonlyArray<DeclaredError>
  }
  readonly codecs: {
    readonly encodeInput: (value: {
      readonly value: unknown
    }) => Effect.Effect<string, Schema.SchemaError>
    readonly decodeError: (
      value: string,
    ) => Effect.Effect<DeclaredError["Type"], Schema.SchemaError>
  }
}

export const servedMember = ({ member, codecs }: ServedMemberSource): ServedMember => {
  const decodeBody = Schema.decodeUnknownEffect(Schema.toCodecJson(member.input))
  const statuses = member.errors.map((error) => [Schema.is(error), declaredStatus(error)] as const)

  return {
    kind: member.kind,
    tag: member.tag,
    input: member.input,
    output: member.output,
    errors: member.errors,
    payload: (body) =>
      decodeBody(body ?? null).pipe(Effect.flatMap((value) => codecs.encodeInput({ value }))),
    failureStatus: (value) =>
      codecs
        .decodeError(value)
        .pipe(
          Effect.map((error) => statuses.find(([is]) => is(error))?.[1] ?? DECLARED_FAILURE_STATUS),
        ),
  }
}
