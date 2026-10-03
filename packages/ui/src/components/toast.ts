import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { entranceStyles } from "../design/motion.ts"
import {
  borders,
  colors,
  conditions,
  dimensions,
  layers,
  radius,
  shadows,
  space,
  typography,
} from "../tokens.stylex.ts"
import { iconButton } from "./icon-button.ts"
import { statusDot, type StatusTone } from "./status.ts"

const styles = stylex.create({
  region: {
    position: "fixed",
    insetBlockEnd: space.lg,
    insetInlineEnd: { default: space.lg, [conditions.compact]: space.md },
    insetInlineStart: { default: "auto", [conditions.compact]: space.md },
    zIndex: layers.toast,
    display: "flex",
    flexDirection: "column-reverse",
    gap: space.sm,
    width: { default: dimensions.toast, [conditions.compact]: "auto" },
    pointerEvents: "none",
  },
  toast: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "start",
    gap: "0.625rem",
    paddingBlock: "0.625rem",
    paddingInlineStart: space.md,
    paddingInlineEnd: space.xs,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.popover,
    boxShadow: shadows.lg,
    pointerEvents: "auto",
  },
  dot: { paddingBlockStart: "0.375rem", display: "inline-flex" },
  copy: { display: "grid", gap: space.xxs, paddingBlockStart: "0.125rem" },
  title: { fontWeight: typography.weightMedium },
  description: { color: colors.mutedForeground, fontSize: typography.small },
})

/** One notification. */
export interface ToastItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly tone: StatusTone
}

/** The visible notifications and the Message that dismisses one. */
export type ToasterConfig<Message> = SlotConfig<Message> &
  Readonly<{
    toasts: ReadonlyArray<ToastItem>
    onDismiss: (id: string) => Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: ToasterConfig<Message>): Html =>
  h.section(
    [
      h.AriaLabel("Notifications"),
      h.AriaLive("polite"),
      h.DataAttribute("slot", "toaster"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.region, config.style),
    ],
    config.toasts.map((toast) =>
      h.keyed("div")(
        toast.id,
        [h.Role("status"), ...styleAttributes(h, styles.toast, entranceStyles.rise)],
        [
          h.span([...styleAttributes(h, styles.dot)], [statusDot(h, toast.tone)]),
          h.div(
            [...styleAttributes(h, styles.copy)],
            [
              h.span([...styleAttributes(h, styles.title)], [toast.title]),
              toast.description === undefined
                ? h.empty
                : h.span([...styleAttributes(h, styles.description)], [toast.description]),
            ],
          ),
          iconButton(h, {
            label: "Dismiss",
            icon: "close",
            onClick: config.onDismiss(toast.id),
            tooltip: "none",
          }),
        ],
      ),
    ),
  )

/** The stack of toasts in the corner of the screen, announced politely as they arrive. */
export const toaster: {
  <Message>(h: HtmlBuilder<Message>, config: ToasterConfig<Message>): Html
  <Message>(config: ToasterConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
