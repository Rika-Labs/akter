import * as stylex from "@stylexjs/stylex"
import { Effect, Function } from "effect"
import * as Dom from "foldkit/dom"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { Children } from "../design/contracts.ts"
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

const styles = stylex.create({
  dialog: {
    display: { default: "none", ":is([open])": "grid" },
    position: "fixed",
    inset: 0,
    zIndex: layers.overlay,
    width: "100%",
    height: "100%",
    margin: 0,
    padding: space.lg,
    borderWidth: 0,
    backgroundColor: "transparent",
    placeItems: "center",
    overflowY: "auto",
  },
  top: {
    alignItems: "start",
    paddingBlockStart: { default: "12vh", [conditions.narrow]: space.lg },
  },
  scrim: {
    position: "fixed",
    inset: 0,
    backgroundColor: colors.backdrop,
    cursor: "default",
  },
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    width: "100%",
    maxWidth: dimensions.dialog,
    maxHeight: "calc(100dvh - 2rem)",
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.popover,
    color: colors.foreground,
    boxShadow: shadows.lg,
    overflow: "hidden",
  },
  palette: { maxWidth: dimensions.palette },
  head: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.md,
    paddingBlock: space.lg,
    paddingInline: "1.125rem",
    paddingBlockEnd: 0,
  },
  titles: { display: "grid", gap: space.xs },
  title: { fontSize: "0.9375rem", fontWeight: typography.weightStrong },
  description: { color: colors.mutedForeground, fontSize: typography.small },
  body: {
    display: "grid",
    gap: space.lg,
    paddingBlock: space.lg,
    paddingInline: "1.125rem",
    overflowY: "auto",
  },
  bare: { padding: 0, gap: 0 },
  foot: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: "1.125rem",
    borderBlockStartWidth: borders.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    backgroundColor: colors.muted,
  },
  hiddenTitle: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
  },
})

/**
 * A modal dialog on the native `<dialog>` element. The element stays mounted so the opening and
 * closing Commands can find it; its content renders only while `open`. Escape, the scrim and the
 * close button all send `onClose`.
 */
export type DialogConfig<Message> = Readonly<{
  id: string
  open: boolean
  title: string
  description?: string
  onClose: Message
  children: Children
  footer?: Children
  variant?: "default" | "palette"
}>

const render = <Message>(h: HtmlBuilder<Message>, config: DialogConfig<Message>): Html => {
  const palette = config.variant === "palette"
  const titleId = `${config.id}-title`
  return h.dialog(
    [
      h.Id(config.id),
      h.AriaLabelledBy(titleId),
      h.AriaModal(true),
      h.OnCancel(config.onClose),
      h.DataAttribute("slot", "dialog"),
      ...styleAttributes(h, styles.dialog, palette && styles.top),
    ],
    config.open
      ? [
          h.div(
            [
              h.AriaHidden(true),
              h.OnClick(config.onClose),
              ...styleAttributes(h, styles.scrim, entranceStyles.fade),
            ],
            [],
          ),
          h.div(
            [...styleAttributes(h, styles.panel, palette && styles.palette, entranceStyles.rise)],
            [
              palette
                ? h.h2([h.Id(titleId), ...styleAttributes(h, styles.hiddenTitle)], [config.title])
                : h.div(
                    [...styleAttributes(h, styles.head)],
                    [
                      h.div(
                        [...styleAttributes(h, styles.titles)],
                        [
                          h.h2(
                            [h.Id(titleId), ...styleAttributes(h, styles.title)],
                            [config.title],
                          ),
                          config.description === undefined
                            ? h.empty
                            : h.p(
                                [...styleAttributes(h, styles.description)],
                                [config.description],
                              ),
                        ],
                      ),
                      iconButton(h, {
                        label: "Close",
                        icon: "close",
                        onClick: config.onClose,
                        tooltip: "none",
                      }),
                    ],
                  ),
              h.div(
                [...styleAttributes(h, styles.body, palette && styles.bare)],
                [...config.children],
              ),
              config.footer === undefined
                ? h.empty
                : h.div([...styleAttributes(h, styles.foot)], [...config.footer]),
            ],
          ),
        ]
      : [],
  )
}

/** A modal dialog; open it with `openDialog` after the Model marks it open. */
export const dialog: {
  <Message>(h: HtmlBuilder<Message>, config: DialogConfig<Message>): Html
  <Message>(config: DialogConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)

/**
 * Shows the dialog with focus trapped inside it and the rest of the page inert, focusing
 * `focusSelector` (or the first focusable element). A missing element is not an error: the Model
 * may already have closed it.
 */
export const openDialog = (target: Readonly<{ id: string; focusSelector?: string }>) =>
  Dom.showDialog(
    `#${target.id}`,
    target.focusSelector === undefined ? {} : { focusSelector: target.focusSelector },
  ).pipe(Effect.orElseSucceed(() => false))

/** Closes the dialog and restores focus to whatever opened it. */
export const closeDialog = (id: string) =>
  Dom.closeDialog(`#${id}`).pipe(Effect.orElseSucceed(() => false))
