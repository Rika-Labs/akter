import { styleAttributes } from "@akter/ui"
import { formatCompact, formatCurrency, formatInteger } from "@akter/ui/geometry"
import { colors, space, typography } from "@akter/ui/tokens.stylex"
import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Routes from "../navigation/routes.ts"
import type { Message } from "../shell/message.ts"
import { dollars, formatGigabytes, formatPeriod } from "../settings/format.ts"
import { CapNotice } from "./model.ts"

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

interface NoticeWording {
  readonly text: string
  readonly action: string | undefined
}

/**
 * What a notice says, and the label of the link to Billing that lifts the cap. An unknown plan has
 * no action in Billing, so its notice has no link.
 */
const noticeWording = (notice: CapNotice): NoticeWording =>
  CapNotice.match<NoticeWording>(notice, {
    Unbound: () => ({
      text: "Billing isn’t set up for this organization, so new commands are refused.",
      action: "Set up billing",
    }),
    UnknownPlan: () => ({
      text: "This organization’s plan isn’t recognised, so new commands are refused. Contact support.",
      action: undefined,
    }),
    CommandCap: ({ period, commands }) => ({
      text: `This organization has used the ${commands === null ? "" : `${formatCompact(commands)} `}commands its plan includes for ${formatPeriod(period)}. New commands are refused until next month; reads keep working.`,
      action: "Upgrade",
    }),
    StorageCap: ({ usedBytes, limitBytes }) => ({
      text: `A tenant stores ${formatGigabytes(usedBytes / 1e9)} of the ${formatGigabytes(limitBytes / 1e9)} its plan allows, so new commands are paused; reads keep working.`,
      action: "Upgrade",
    }),
    SpendCap: ({ period, limitCents }) => ({
      text: `${formatPeriod(period)}’s spend has reached the ${formatCurrency(dollars(limitCents))} limit, so new commands are refused; reads keep working.`,
      action: "Change the limit",
    }),
    ConnectionCap: ({ open, limit }) => ({
      text: `This organization holds ${formatInteger(open)} of the ${formatInteger(limit)} live connections its plan allows, so new connections are refused until one closes.`,
      action: "Upgrade",
    }),
  })

const noticeAttributes = (h: HtmlBuilder<Message>) => [
  h.Role("note"),
  h.DataAttribute("slot", "cap-notice"),
  ...styleAttributes(h, styles.notice),
]

/** The one quiet line a page shows while a cap refuses new work, and a link to lift it in Billing. */
export const capNoticeView: {
  (notice: CapNotice): (h: HtmlBuilder<Message>) => Html
  (h: HtmlBuilder<Message>, notice: CapNotice): Html
} = Function.dual(2, (h: HtmlBuilder<Message>, notice: CapNotice): Html => {
  const { text, action } = noticeWording(notice)
  return h.p(
    noticeAttributes(h),
    action === undefined ? [text] : [`${text} `, billingLink(h, action)],
  )
})

/** The same line on Billing itself, where the way out is on the page rather than behind a link. */
export const capStateView: {
  (notice: CapNotice): (h: HtmlBuilder<Message>) => Html
  (h: HtmlBuilder<Message>, notice: CapNotice): Html
} = Function.dual(2, (h: HtmlBuilder<Message>, notice: CapNotice): Html =>
  h.p(noticeAttributes(h), [noticeWording(notice).text]),
)
