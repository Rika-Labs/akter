import type { CommandCaller } from "@akter/cloud-api"
import { Function, Match } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { unknown } from "../shell/unknown.ts"
import type { Person } from "../workspace/model.ts"

/** The subject prefix the control plane gives a command an API key sent. */
const apiKeyPrefix = "api-key:"

/** The subject prefix the control plane gives a command a signed-in member sent. */
const userPrefix = "user:"

/**
 * Whom a command ran as, in words. The control plane attributes a console command to `user:<id>`
 * or `api-key:<id>`. The runtime pages know one member, the signed-in person, so their own commands
 * read as their name and any other member's as the subject; no API key names are loaded here, so a
 * key reads as `API key …` and the end of its id. Any other subject, such as one an application's
 * own authentication chose, reads as written. Deliveries the framework made read `System`, and
 * unauthenticated callers `Anonymous`.
 */
export const callerText =
  (person: Pick<Person, "id" | "name">) =>
  (caller: CommandCaller | null): string => {
    if (caller === null) return unknown
    return Match.value(caller.kind).pipe(
      Match.when("system", () => "System"),
      Match.when("anonymous", () => "Anonymous"),
      Match.when("user", () => {
        const { subject } = caller
        if (subject === null) return unknown
        if (subject.startsWith(apiKeyPrefix)) return `API key …${subject.slice(-6)}`
        const own =
          person.id !== "" && person.name !== "" && subject === `${userPrefix}${person.id}`
        return own ? person.name : subject
      }),
      Match.exhaustive,
    )
  }

/**
 * Whom a command ran as, as a table cell. Its title holds the full identity, the subject or the
 * source of a system delivery, which the words may shorten or replace with a name.
 */
export const callerCell: {
  <Message>(
    h: HtmlBuilder<Message>,
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): Html | string
  (
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): <Message>(h: HtmlBuilder<Message>) => Html | string
} = Function.dual(
  3,
  <Message>(
    h: HtmlBuilder<Message>,
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): Html | string => {
    const text = callerText(person)(caller)
    const title = caller?.subject ?? caller?.source ?? null
    return title === null ? text : h.span([h.Title(title)], [text])
  },
)
