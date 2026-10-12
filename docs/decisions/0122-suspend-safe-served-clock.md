# ADR 0122: Suspend-safe served database time

Status: accepted, 2026-10-12.

## Context

The served clock estimates database time from a cached offset to `performance.now()`. A suspended process can resume with a paused or discontinuous monotonic clock. A shorter pre-suspend round trip can remain preferred even after a newer sample observes the changed offset. Publishing that estimate through `/protocol` and `durable-now` corrupts locally minted SDK identities without changing the database's admission clock. Server-side command-ID minting already reads database time directly.

## Decision

Compare wall and monotonic elapsed time with the retained sample before publishing time. Resample if their disagreement exceeds 250 milliseconds, the monotonic clock moves backward, or the sample is one minute old. Wall time detects discontinuity; it never supplies the authoritative timestamp. Serialize sampling and recheck after waiting so concurrent resumed requests share the required refresh. Reject a sample whose own round trip spans a discontinuity. Periodic sampling also replaces an offset whose change exceeds the combined round-trip uncertainty and the discontinuity threshold, even if its round trip is slower.

Both `/protocol`'s body and response headers await this check. A failed refresh returns retryable unavailable without a stale time header. Warm requests retain cached reads and the existing ten-second periodic sampler. Identity windows, future-ID refusal, expiry and receipt checks still use database authority with no grace or replacement IDs.

## Evidence and consequences

[Clock regression evidence](../verification/served-clock.md) includes positive and negative discontinuities, a slower post-resume sample, concurrent requests, a failed resample, and real Postgres/PGlite HTTP identity admission. This repairs served clock estimation, not pooled-connection recovery, provider wake latency or a Fly HTTP 502. No deployment or provider availability claim follows from these tests.
