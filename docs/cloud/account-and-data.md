---
title: "Account deletion and personal export"
description: "Export your personal records and understand organization and account cleanup."
---

Export any records you want to keep **before** requesting deletion. Organization deletion and personal account deletion are different operations, and neither is reversible.

## Export your personal data

In **Settings → Account → Profile**, choose **Export my data**. The console downloads a JSON file containing the records Akter stores about the signed-in user, including retained billing and audit records. It excludes passwords, session tokens, OAuth credential values and verification secrets.

This is a personal-data export, not a backup of your actors or customer database. Store the downloaded file securely: it contains personal information.

## Delete an organization

Only an unsuspended owner can request organization deletion. In **Settings → Organization**, choose **Delete organization**, type the organization's name and confirm.

Acceptance immediately fences new mutations and deployments and revokes API keys and serving routes. Cleanup then runs in the background: billing cancellation, runner retirement, database removal and final organization-record removal, in that order. The organization remains listed while cleanup is pending. A failure retains the obligation for retry rather than declaring deletion complete. A suspended organization cannot accept a deletion request; contact support instead.

Existing subscriptions are cancelled immediately without automatic proration, with a final invoice for outstanding metered usage. Existing invoices and accounting obligations remain authoritative. Export what you need before confirming; there is no documented undo or customer restore path.

## Delete your account

If you are an organization's sole owner, first transfer ownership to another member or wait for that organization's deletion to **complete**. Starting organization deletion alone does not satisfy this requirement.

In **Settings → Account → Profile**, choose **Delete account**, type your current email address and confirm. If you are a surviving organization's billing contact, cleanup first transfers that contact to a surviving owner. Transient failures retain pending cleanup and retry; an ownership problem must be resolved before it can proceed.

Completed personal cleanup removes identity credentials, sessions, memberships, personal settings and user-owned keys, and signs you out. Authored audit entries use an anonymized identity without your name or IP address. Pending identity mail is cancelled, but cancellation cannot recall a message already accepted by the email provider.

## What is retained

Deletion is not a promise to erase every historical record. Billing records and actor receipts remain for accounting obligations. Suspension and staff audit records remain for abuse prevention; personal export includes those user-scoped records. Short-lived email/IP abuse counters expire normally rather than being reset by deletion. Re-registering the same address is not blocked by an implied email denylist.
