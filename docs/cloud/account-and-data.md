---
title: "Account and data"
description: "What happens to your data when you export it or delete an account, organization, project, or environment."
---

# Account and data

Akter Cloud holds two kinds of data. Control-plane records describe you and your organization: your profile, memberships, projects, keys, billing, and audit entries. Application data is what your actors store, which lives in each environment's [store](./storage.md). Exporting or deleting one does not do anything to the other, so plan each separately.

## Export

A personal-data export contains the control-plane records about you, including the billing records and audit entries that Akter retains. It is not a backup of your app's data. Passwords, session tokens, OAuth credential values, and verification secrets are never exported.

Export anything you need from your app's stores before you delete an environment, project, or organization. Akter Cloud does not offer point-in-time restore.

## Delete an environment, project, or organization

Deleting an environment, project, or organization retires the stores involved. Akter immediately stops issuing credentials for them and marks them `retiring`. After 30 days, Akter empties and deletes each bucket, and it retries any step that fails until it completes. The 30-day wait is a retention period for cleanup, not a way to restore a deleted environment. Creating an environment with the same name later gives you a new, empty store.

Deleting an organization runs in this order:

1. Akter stops new changes and deployments, and revokes the organization's keys and serving routes. Reads keep working.
2. It cancels every subscription right away, without proration, and sends a final invoice for any usage not yet billed.
3. It retires the organization's runners.
4. It marks every store as `retiring`.
5. It removes the organization's projects, environments, keys, memberships, and other records.

Only an owner can delete an organization. The 30-day store cleanup continues after the organization's records are gone.

## Delete your account

To delete your account, confirm your current email address. Akter refuses to delete the account of an organization's only owner. Transfer ownership first, or delete the organization.

Deleting your account removes your sign-in credentials, sessions, memberships, personal settings, and the keys you own. If you are an organization's billing contact, Akter moves that role to a remaining owner first. Audit entries that you authored stay, under an anonymized identity without your name or IP address.

Akter keeps some records after you delete your account. Billing records are kept for tax and accounting obligations, and a recorded account suspension is kept to prevent abuse. Deletion does not promise to erase every historical record at once.

## Application data and erasure

Your stores keep history and checkpoints for a while after the actors that wrote them change. Earlier versions of personal data can remain in them until your plan's [retention window](./storage.md#retention) and Akter's cleanup have passed. If you must erase a person's data from your app, read [History retention](../operations/retention.md) to see how long it can stay.
