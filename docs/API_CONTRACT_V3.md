# Laundry — proposed API contract v3

Status: design only, not deployed. Base /api/v1; JSON; RUB amounts integer kopeks; UTC ISO timestamps. OpenAPI 3.1 and Zod validation should be generated after schema signoff.

## Shared contract
Idempotency-Key required on bookings, custody, payments, claims decisions and refunds. If-Match or expected_version for mutations. X-Request-ID for tracing. Error shape: {error:{code,message,request_id,details}}. Errors: VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT_VERSION, INVALID_TRANSITION, CAPACITY_UNAVAILABLE, QUOTE_EXPIRED, APPROVAL_REQUIRED, PAYMENT_PENDING, DEPENDENCY_UNAVAILABLE. Never expose another tenant's resource existence.

## Customer
GET /service-areas/resolve
GET /catalog
GET /windows?building_id=&kind=
POST /quotes — address, service lines, tier, requested windows, exceptions → immutable quote, fee lines, expiry, terms version.
POST /orders — quote_id, accepted_quote_hash, accepted_terms_version → order ID and pending/confirmed status.
GET /orders; GET /orders/:id; GET /orders/:id/timeline.
POST /orders/:id/slot-change-quotes — requested kind and window → fee quote.
POST /orders/:id/slot-changes — accepted quote hash → capacity/payment orchestration.
POST /orders/:id/cancel — reason and policy version.
POST /orders/:id/adjustments/:adjustment_id/decision — accept or decline and approval version.
POST /orders/:id/claims — type, affected items, description, evidence references.

## Courier/driver
GET /courier/shifts/current; GET /courier/routes/current.
POST /courier/scan-events/sync — device_id and events with client_event_id, entity_code, captured_at, context, expected_version → accepted, duplicate, rejected, pending lists.
POST /courier/stops/:id/arrive.
POST /courier/stops/:id/intake — order, bag, seal, weight, manifest, confirmation.
POST /courier/handoffs — from/to party, bag scans, manifest hash, recipient confirmation.
POST /courier/deliveries/:id/attempts — outcome, recipient proof, evidence, reason.
Driver transport-only role must not create protected garment inventory.

## Partner
GET /partner/expected-receipts.
POST /partner/receipts — handoff, bag/seal scans, actual weight, discrepancies.
POST /partner/orders/:id/inspection — findings and optional proposed adjustment.
POST /partner/batches — process type and item refs.
POST /partner/batches/:id/operations — operation and expected version.
POST /partner/orders/:id/quality-check — item results and evidence.
POST /partner/orders/:id/ready — manifest hash and bag scans.
GET /partner/invoices; POST /partner/invoice-lines/:id/disputes.

## Dispatch/support/finance/admin
GET /dispatch/dashboard; POST /dispatch/windows; POST /dispatch/routes; POST /dispatch/routes/:id/reassign.
GET /claims; POST /claims/:id/assign; POST /claims/:id/decisions.
GET /finance/customer-reconciliation; GET /finance/partner-reconciliation.
POST /finance/refunds; POST /finance/partner-invoices/:id/reconcile.
POST /admin/tariff-versions; POST /admin/tariff-versions/:id/publish.

## Webhooks
POST /webhooks/payments/:provider; POST /webhooks/fiscal/:provider; POST /webhooks/notifications/:provider. Verify signatures, store unique provider event in durable inbox, acknowledge only after insert, process async with idempotency.

## Detailed premium-slot workflow
1. Client requests special pickup quote; price example +50000 kopeks, quote version and expiration.
2. Client explicitly accepts amount and time.
3. Server locks slot capacity, creates held reservation and acceptance record atomically.
4. Payment authorization begins; success confirms reservation, failure releases it.
5. If reservation fails after authorization, void it; if capture occurred, refund and open reconciliation incident.
6. Client sees confirmed slot only after coherent financial and capacity state.
7. Retry with same key returns same response; same key with different payload returns conflict.

## Detailed protected intake workflow
Courier sends immutable item manifest, photos verified in private storage, garment IDs, condition and customer confirmation. Reject reused seal, unknown item, wrong route, missing mandatory evidence or stale version. Commit manifest and custody event together with outbox.

## Detailed handoff workflow
Courier submits expected manifest; partner independently scans actual bags/seals. Discrepancy opens incident and pending handoff; cannot silently mark partner_received.

## Contract tests
RBAC and IDOR; optimistic concurrency; duplicate webhooks; retry with identical/different payload; offline sync; concurrent slot holds; cross-partner isolation; claims evidence; financial ledger and receipt state.
