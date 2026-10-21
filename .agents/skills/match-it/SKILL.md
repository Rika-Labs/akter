---
name: match-it
description: Matches a UI's appearance and interactions to an outside reference with a frozen state inventory and measured acceptance criteria. Use for "match it", "pixel perfect", "copy Linear", or a reference screenshot or URL.
---

# Match it

Done: every required reference state meets the declared visual and behavioral criteria, intentional
differences are approved, and a fresh verifier accepts the frozen evidence. Without a reference, use `align-it`.

1. **Freeze the reference before building.** Use `browse-it` for the driver and profile, never a profile
   hardcoded here. Capture the complete [state inventory](references/states.md), not just the landing
   page. Record reference URL or file hash, capture time, viewport, DPR, zoom, browser, theme, data and
   state. A screenshot proves only its visible state; unreachable states stay blocked, not N/A or matched.
2. **Declare the contract.** For each region, name exact matches, brand/token mappings, permitted
   fonts/assets, exclusions and numerical tolerances in [acceptance](references/measure.md). Do this
   before seeing the target diff. Copy no proprietary assets. Inspect computed styles and font loading;
   map onto existing tokens. A missing reference font invalidates typography comparison, not the task.
3. **Build from the inventory.** Structure first, then typography, color roles and details. Keep a
   discrepancy ledger: state, region, expected, actual, evidence, owner and disposition. An exclusion or
   later-discovered state needs an explicit scope decision; never silently shrink the inventory.
4. **Measure settled states.** Use the reusable capture/comparison utilities in
   [references/measure.md](references/measure.md). Compare identical conditions, screenshot regions and
   declared metrics; do not blur away required focus states. Pixel percentage is diagnostic, not a
   universal pass threshold. `align-it` overlays are diagnostic too: Range/canvas bounds and transformed
   SVG boxes are not proven glyph/stroke ink. Never claim subpixel ink precision from those estimates.
5. **Test arrival and transitions separately.** Follow [references/states.md](references/states.md) for
   cold/warm entry, delayed fonts, theme, mid-page reload, history, search and keyboard/mobile flows.
   Record before navigating; state the browser, cache conditions and sampled frame rate. A settled
   screenshot or sampled recording cannot establish "never shifts" or "never flashes" universally.
6. **Close a bounded handoff.** Freeze reference hashes, target SHA, criteria, scripts, discrepancies and
   evidence. Give `break-it` that exact bundle: recheck affected states plus adjacent navigation/theme/
   responsive states after each fix; widen only when evidence finds a shared cause. Use its three-round
   limit. Required unknowns are INCONCLUSIVE. Hand delivery to `prove-it`: verify actual deployed HTML,
   fonts, headers and browser behavior independently of local/export parity.

**Reply:** reference and scope, mappings/exclusions, state ledger and criteria, measured differences,
before/after images, arrival/interaction evidence, verifier verdict and delivery evidence or blockers.
