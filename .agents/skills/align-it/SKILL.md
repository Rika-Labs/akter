---
name: align-it
description: Makes a control line up by measuring glyph and icon ink with red-line overlays. Use for "align it", "off-center", "sits low", "uneven padding", "spacing looks off" or "x-ray it".
---

# Align it

Done: every center, edge, visible inset and gap you named is within 0.5 CSS px at every checked viewport and
theme, and no ink is clipped. To match an outside reference, use `match-it`.

1. **Target.** One sentence: what aligns with what. Icon beside text: cap-height center. Text beside text:
   shared baseline.
2. **Reproduce.** Your own stack (`../prove-it/references/stack.md`) at the reported viewport, theme, zoom
   and state, then 1440×900 and 390×844 in light and dark (`browse-it`). After `document.fonts.ready`, list
   the loaded fonts; a fallback font (often the default monospace on `kbd`) invalidates every number. Take a
   clean screenshot.
3. **X-ray.** Run [references/measure.md](references/measure.md) on the control and on its parent.
   Screenshot, remove the overlay, and record dx, dy, insets, gaps and clipping. These are diagnostic
   estimates; precise ink acceptance needs a validated raster/font method or remains INCONCLUSIVE.
4. **Fix the cause, in this order:** structure (padding vs gap vs margin, line-height, flex or grid
   alignment, shrink, wrap, artwork outside the viewBox, inline whitespace); fonts; `text-box` trimming;
   last, an optical nudge sized from the measurement. Use the repo's tokens. No measurement or overlay in
   product code.
5. **Guard.** Re-measure everywhere, then add a browser test that asserts ink, not box centers, following
   the documentation UI's existing tests in `apps/docs/src/components`. There is no shared ink-measurement
   fixture; keep the overlay out of product code. Never widen a tolerance to pass.

**Reply:** target, cause, offset table before → after, clean and red-line screenshots, the test added.
