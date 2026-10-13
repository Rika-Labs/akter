# ADR 0138: A checkpoint anchor for the retained history window

Status: proposed, 2026-10-13. This records an E6 retention conflict; it is not an accepted change to the pruning protocol.

## Context

ADRs 0127 and 0132 retain history for a store's window, but expire every older checkpoint except the newest. Retained action deltas do not reconstruct historical state when the state they started from belonged to an older checkpoint. The current fork reader excludes that older checkpoint, and trim can remove its preceding log prefix.

Seed 900 reproduces this on the seeded bucket: create 90 list items at actor version 1 and drain, advance eight days, admit changes to items 17 and 29 as versions 2 and 3, drain, age the checkpoint eleven minutes, and trim. The trim removes through offset 3. Forking version 2, admitted inside the current seven-day window, fails with `CorruptSegment` for log offset 1 instead of reconstructing the independently expected 90-item version-2 image. The failure persists after the E7 merge.

## Proposed decision

Keep the newest checkpoint strictly before the first segment inside retention as the window's anchor. Keep the complete chain after that anchor, including any older segments between the anchor and the first retained segment; keeping only the checkpoint would still lose those deltas. When no segment lies inside retention, the newest checkpoint remains the sole required expired root.

The history catalogue exposes this anchor alongside in-window checkpoints. A fork may restore the older anchor, but must still refuse a requested actor position older than retention. Trim stops at the anchor offset. GC roots the anchor and every fork/replay image referenced by the chain after it, in addition to the newest and in-window checkpoints. Other expired checkpoints can be removed. When the boundary advances past a newer checkpoint, the anchor and chain advance with it.

This retains at most one additional expired checkpoint per shard plus the tail needed to reach the window. It changes the "except the newest" pruning clause of ADR 0127; that change needs the captain's decision before implementation and promotion.

## Required evidence

Add a seeded regression that reconstructs version 2 after trim and GC, with item 17 changed, item 29 unchanged, all 90 items present, and no copied work by default. Cover the exact retention boundary and advance it far enough to release the old anchor. Run the same protocol on filesystem and MinIO, and preserve E7's shared state/index checkpoint and atomic replay/audit guarantees.
