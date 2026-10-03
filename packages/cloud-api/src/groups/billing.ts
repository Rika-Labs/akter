import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import {
  AuditEntry,
  BillingSummary,
  HostedSession,
  Invoice,
  SetSpendLimit,
  SpendLimit,
  StartCheckout,
  Usage,
} from "../billing.ts"
import { ReadErrors, WriteErrors } from "../errors.ts"
import { BillingPeriod, OrganizationId, Page, pageQuery } from "../primitives.ts"

const organizationParams = { organizationId: OrganizationId }

export class BillingGroup extends HttpApiGroup.make("billing").add(
  HttpApiEndpoint.get("get", "/organizations/:organizationId/billing", {
    params: organizationParams,
    success: BillingSummary,
    error: ReadErrors,
  }),
  HttpApiEndpoint.get("listInvoices", "/organizations/:organizationId/billing/invoices", {
    params: organizationParams,
    success: Schema.Array(Invoice),
    error: ReadErrors,
  }),
  HttpApiEndpoint.put("setSpendLimit", "/organizations/:organizationId/billing/spend-limit", {
    params: organizationParams,
    payload: SetSpendLimit,
    success: SpendLimit,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("startCheckout", "/organizations/:organizationId/billing/checkout", {
    params: organizationParams,
    payload: StartCheckout,
    success: HostedSession,
    error: WriteErrors,
  }),
  HttpApiEndpoint.post("openPortal", "/organizations/:organizationId/billing/portal", {
    params: organizationParams,
    success: HostedSession,
    error: WriteErrors,
  }),
) {}

export class UsageGroup extends HttpApiGroup.make("usage").add(
  HttpApiEndpoint.get("get", "/organizations/:organizationId/usage", {
    params: organizationParams,
    query: { period: Schema.optional(BillingPeriod) },
    success: Usage,
    error: ReadErrors,
  }),
) {}

export class AuditGroup extends HttpApiGroup.make("audit").add(
  HttpApiEndpoint.get("list", "/organizations/:organizationId/audit-log", {
    params: organizationParams,
    query: {
      ...pageQuery,
      action: Schema.optional(Schema.String),
      actorId: Schema.optional(Schema.String),
    },
    success: Page(AuditEntry),
    error: ReadErrors,
  }),
) {}
