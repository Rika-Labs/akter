import { Schema } from "effect"

/**
 * `attach` refused a content reference: its grant is malformed, was not
 * issued by this deployment for this tenant and content, or leaves less
 * than the skew margin before it expires. A reference from a client is input,
 * so a command declares or handles this like any other application failure.
 */
export class InvalidContentRef extends Schema.TaggedError<InvalidContentRef>()(
  "InvalidContentRef",
  { reason: Schema.Literals(["malformed", "invalid", "expired"]) },
) {}

/** An upload passed the content size limit; nothing of it was stored. */
export class ContentTooLarge extends Schema.TaggedError<ContentTooLarge>()("ContentTooLarge", {
  maxBytes: Schema.Int,
}) {}
