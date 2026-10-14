# T1/T2 provider measurement deferred for 0.2.0 (2026-10-14)

**Responsibility:** record that 0.2.0 releases without ADR 0124's provider-named T1/T2 measurement.  
**Authority:** dated release decision; not evidence.  
**Owner role:** framework release.

ADR 0124's milestone table requires, for E2, "`Store.s3` against MinIO in CI and the chosen provider nightly: F6–F12, the ambiguous-append case and T1/T2 measured with the provider named". The MinIO and F6–F12 parts have evidence in [E2 recovery](../e2-recovery.md). The provider-named T1/T2 measurement does not exist.

On 2026-10-14 Dallen directed that performance testing is deferred ("No performance testing for now"). Under that instruction the release captain decided to release 0.2.0 without the T1/T2 provider measurement.

Consequences:

- 0.2.0 makes no provider latency or throughput claim for R2, Tigris, AWS S3 or any other provider.
- The local MinIO measurements in [BENCHMARKS.md](../../../BENCHMARKS.md) were taken on a Mac that is not CPU-qualified for the targets. They are diagnostics, not a T1 or T2 pass.
- The [support matrix](../../operations/support-matrix.md) records provider performance as not measured.
- The gate stays open. A later provider run must name the provider, region, endpoint and runtime and record its result in the [provider matrix](../store-providers.md) before any performance claim is made.
