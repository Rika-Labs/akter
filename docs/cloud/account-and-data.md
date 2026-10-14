---
title: "Account deletion and data custody"
description: "Distinguish personal records from hosted actor stores and their retirement obligations."
---

# Account deletion and data custody

Export what you need before deleting an account, organization, project, or environment. A personal-data export contains control-plane records about the user, not a backup of the application's actor store. Never expect passwords, session secrets, or storage credentials in an export.

## Environment and organization data

Akter 0.2 Cloud holds end-user actor state, lists, payloads, outcomes, and history in each environment's store bucket. Deletion is not merely removal of runners or variables. The hosted target fences the incarnation, removes access, stops credential minting, and retains a durable store-retirement obligation. After the 30-day post-deletion window it empties and deletes the bucket; failure is retried rather than reported complete.

Same-name recreation uses a new incarnation and store. The window is not a customer-facing undelete feature. Disposable closed pull-request preview stores have separately guarded immediate teardown. Provider deletion and isolation require their own hosted evidence; this page describes the target, not a validated production result.

## Personal account records

Resolve sole-organization ownership before deleting a personal account. Personal cleanup removes identity credentials, sessions, memberships, settings, and user-owned keys. Billing, security, and audit retention follow the applicable policy and legal obligations; deletion is not a promise to erase every historical record immediately.

Actor erasure also depends on retained checkpoint reachability and GC grace periods. See [storage](./storage.md) and [retention](../operations/retention.md). Prices, refunds, and plan quotas belong to approved E8 policy, not this framework document.
