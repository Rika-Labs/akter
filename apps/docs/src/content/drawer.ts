/** Where focus goes when the drawer changes state: into the drawer, or back to its button. */
export type DrawerFocus = "enter" | "return" | undefined

/**
 * What to do with focus when the drawer goes from `was` to `now`. Opening moves focus into
 * the drawer, so a reader on the keyboard is not left on a button that is now behind it.
 * Closing puts focus back on the button that opened it, so the reader is not left on a page
 * that was hidden or on nothing. A drawer that was never open, or whose state did not change,
 * leaves focus where it is, which is what keeps the first load from taking focus.
 */
export const drawerFocus = (was: boolean, now: boolean): DrawerFocus => {
  if (was === now) return undefined

  return now ? "enter" : "return"
}
