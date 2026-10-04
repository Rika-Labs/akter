import { styleAttributes } from "@akter/ui"
import { formatCompact, formatCurrency } from "@akter/ui/geometry"
import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import type { Message } from "../shell/message.ts"
import { dollars, formatPeriod } from "../settings/format.ts"
import type { CapNotice } from "./model.ts"

const styles = stylex.create({
  notice: {
    margin: 0,
    paddingBlock: space.sm,
    color: colors.mutedForeground,
    fontSize: typography.small,
  },
  link: {
    color: colors.foreground,
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
})

/** A link to Billing, where a plan or the spend limit is changed; quota refusals end with it. */
export const billingLink: {
  (label: string): (h: HtmlBuilder<Message>) => Html
  (h: HtmlBuilder<Message>, label: string): Html
} = Function.dual(2, (h: HtmlBuilder<Message>, label: string): Html =>
  h.a([h.Href(Routes.settingsBilling()), ...styleAttributes(h, styles.link)], [label]),
)

/** The one quiet line a page shows while a cap refuses new commands, and how to lift it. */
export const capNoticeView: {
  (notice: CapNotice): (h: HtmlBuilder<Message>) => Html
  (h: HtmlBuilder<Message>, notice: CapNotice): Html
} = Function.dual(2, (h: HtmlBuilder<Message>, notice: CapNotice): Html =>
  h.p(
    [h.Role("note"), h.DataAttribute("slot", "cap-notice"), ...styleAttributes(h, styles.notice)],
    notice.cap === "commands"
      ? [
          `This organization has used the ${formatCompact(notice.limit)} commands Free includes for ${formatPeriod(notice.period)}. New commands are refused until next month; reads keep working. `,
          billingLink(h, "Upgrade"),
        ]
      : [
          `${formatPeriod(notice.period)}’s spend is past the ${formatCurrency(dollars(notice.limit))} limit, so new commands are refused; reads keep working. `,
          billingLink(h, "Change the limit"),
        ],
  ),
)
