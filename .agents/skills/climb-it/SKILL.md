---
name: climb-it
description: Improves a measurable target one experiment at a time against a frozen benchmark, and settles "which approach?" by measurement. Use for "optimize", "make it faster", "hill climb", prompt tuning, or two approaches being argued.
---

# Climb it

Done: the metric stopped improving beyond the noise floor, or the target or budget was reached, with every
experiment logged and the guard intact.

1. **Target.** Before touching code: the metric and direction, a guard that must never regress
   (correctness, error count, output equality, edge cases such as rollback), and a budget. Measure what users
   get; a micro gain on 1% of the path moves the total at most 1%.
2. **Harness.** One command prints the metric, the guard, the error count and proof the work happened (rows,
   requests, outputs compared). Realistic data, production flags. Run untouched code at least 5 times; the
   range is the noise floor. Busy machine (`uptime`): interleave sides and log the load. After the first
   measured run the harness is frozen; a wrong harness means starting over. Use an existing benchmark
   runner only if the owning package declares it; otherwise keep the harness in a work directory outside
   the repo (example runner name: `run.sh`). There is no root benchmark or eval command.
3. **Loop.**
   1. Name the limiter (profile in an unreported run); pick the one change aimed at it.
   2. Make that one change; run at least 5 times.
   3. Keep it only if the guard holds, errors stay zero and the median beats the best by more than the noise
      floor; commit with the number. Otherwise revert.
   4. Append to `results.tsv`: change, median, range, n, guard, kept or reverted.
4. **Stop** after three experiments inside the noise, a spent budget, or a met target. Confirm final vs
   original alternating A, B, A, B, at least 5 each.

**Which approach?** Each candidate behind the same harness, in its own worktree, tuned as production would
run it, run interleaved. Best metric that passes the guard wins; a guard failure is DISQUALIFIED; a gap
inside the noise is a tie, so take the simpler. Confirm the winner against baseline, and against the
runner-up when ranges overlap or the gap is under 30%.

**Reply:** target, guard, budget; how to re-run; baseline vs final with runs and range; the `results.tsv`
table; the final limiter and why it stopped (or the winner, margin and tuning per side).
