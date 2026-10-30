# ADR 0122: Suspend-safe served database time

Status: accepted, 2026-10-12.

**0.2 status:** amended (suspend-safe time carries onto owner validity); owned by [ADR 0126](0126-shard-ownership-on-the-bucket-log.md). See the [0.2 registry](0124-engine-rewrite-and-command-log.md#registry-of-earlier-decisions).

## Context

The served clock estimates database time from a cached offset to `performance.now()`. A suspended process can resume with a paused or discontinuous monotonic clock. A shorter pre-suspend round trip can remain preferred even after a newer sample observes the changed offset. Publishing that estimate through `/protocol` and `durable-now` corrupts locally minted SDK identities without changing the database's admission clock. Server-side command-ID minting already reads database time directly.

## Decision

Compare wall and monotonic elapsed time with the retained sample before publishing time. Resample if their disagreement exceeds 250 milliseconds or the monotonic clock moves backward. Wall time detects discontinuity; it never supplies the authoritative timestamp. Serialize sampling and recheck after waiting so concurrent resumed requests share the required refresh. Reject a sample whose own round trip spans a discontinuity. The ten-second background loop replaces a sample at one minute of monotonic age, or an offset whose change exceeds the combined round-trip uncertainty and the discontinuity threshold, even if its round trip is slower. Age alone never blocks a request.

Both `/protocol`'s body and response headers await the discontinuity check. A failed header refresh omits `durable-now` without replacing the handler's response, including a committed command result. `/protocol` itself returns retryable unavailable when it cannot establish its time payload. Warm requests retain cached reads. Identity windows, future-ID refusal, expiry and receipt checks still use database authority with no grace or replacement IDs.

## Provider residual window

Fly's [clock correction description](https://community.fly.io/t/better-paradox-prevention-suspend-resume-clocks/25959), accessed 2026-10-12, says the guest wall clock is synchronized from `kvm-clock` when a new vsock connection arrives, probably within a few hundred milliseconds, but an application can serve a whole request before correction. If wall and monotonic clocks pause together, their initial divergence can be zero, so this detector does not establish correctness in that residual window.

In the observed 2026-10-12 resume, the provider recorded completion at 00:36:48.823Z. The earliest retained guest application log afterward stamped 00:36:59.002Z and was ingested at 00:36:59.003Z, agreeing within one millisecond 10.179 seconds after resume. No earlier application clock sample establishes the exact correction latency. The edge's first successful `/ready` probe finished around 00:37:04.026Z, after that confirmed correction, and `/protocol` began at 00:37:04.027Z. Probing covered the residual window in this event, not by contract: a runner whose readiness recovers faster can still receive requests before wall-clock correction. No `/dev/ptp0` dependency or unconditional database read is introduced without evidence of that path being hit.

## Evidence and consequences

[Clock regression evidence](../verification/served-clock.md) includes positive and negative discontinuities, a slower post-resume sample, concurrent requests, a failed resample, and real Postgres/PGlite HTTP identity admission. This repairs served clock estimation, not pooled-connection recovery, provider wake latency or a Fly HTTP 502. No deployment or provider availability claim follows from these tests.
