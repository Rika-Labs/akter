---
title: "Pricing and limits"
description: "Separate framework limits from hosted 0.2 prices and quotas still owned by E8."
---

# Pricing and limits

0.2 Cloud owns a store bucket per environment as well as runner compute. The former customer-database billing description does not define the new hosted product. E8 owns approved prices, included usage, storage/action metering, quotas, and preview terms; this page publishes no unapproved amounts or allowances.

Use the hosted plan catalog and account billing surface for the active offering, and pin the public cloud API version used to decode it. A schema in the framework repository is not evidence that a new price, meter, or cap has been deployed.

## Framework bounds

The non-list actor state limit is 256 KiB; list data lives in pages. `find` returns ids only and limits a query to at most 1,000. Client command ids last ten minutes. These are framework bounds, not included plan usage or service-level objectives.

Durable latency includes the provider PUT. Provider atomicity, performance, hosted isolation, and quota behavior need their actual evidence. The [support matrix](../operations/support-matrix.md) and [storage guide](storage.md) explain those boundaries.
