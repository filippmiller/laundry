# Audit plan and acceptance gates

## Audit scope
1. Product: customer, courier, partner laundry, dispatch, support, finance and super-admin journeys.
2. Operations: pickup windows, route density, capacity, handoff, sorting, batching, QC, delivery and failed attempts.
3. Trust: Economy vs Protected intake, declared value, evidence capture, seals, custody chain, retention and claims.
4. Finance: price snapshots, minimums/rounding, partner wholesale rates, payment idempotency, refunds, partner settlement and reconciliation.
5. Legal: consumer contract, household-services receipt, liability, personal data, recording, online cash register and partner agreements under Russian law.
6. Engineering: tenancy boundaries, RBAC, schema constraints, migrations, event integrity, observability, backups, CI and security.
7. OSS: source code, license, activity, maintenance, security, dependency health, compatibility and extraction cost.

## Required scenario matrix
For every journey record: ID, actor, preconditions, happy path, alternate paths, failure modes, expected state changes, events emitted, evidence, notification, financial effect, permission check and acceptance test.

Minimum adversarial cases:
- Duplicate QR scan, duplicate webhook and retry after timeout.
- Courier offline while accepting and handing off a bag.
- Seal number mismatch, broken seal, missing label and scale unavailable.
- One order split across two processing batches and rejoined.
- Similar garments from two customers accidentally mixed.
- Customer adds an expensive item after Economy intake.
- Partner rejects a garment after intake; customer unreachable.
- Price changes after inspection; customer declines.
- Laundry damages an item; evidence was not uploaded or is inaccessible.
- Customer alleges missing item; courier and partner manifests disagree.
- Delivery to wrong apartment, recipient unavailable, customer refuses delivery.
- Partial delivery and partial refund; payment provider sends duplicate events.
- Partner invoice differs from expected wholesale tariff.
- Staff member accesses another tenant's customer or media.
- Data deletion request while a claim/legal hold is active.
- Video retention expiry, evidence export and audit of staff access.

## Release gates
**Gate A — discovery:** repo stack and current files inspected; product boundaries and assumptions recorded.
**Gate B — product/legal:** service role, customer contract, tariff distinction, liability, PD and video recording reviewed by Russian counsel.
**Gate C — architecture:** domain model, state machines, role matrix, API contracts, data retention and migration plan approved.
**Gate D — pilot readiness:** pricing and partner contracts confirmed; route economics measured on pilot buildings; manual fallback documented.
**Gate E — implementation:** unit, integration, migration, E2E, security and tenant-isolation tests pass; independent review completed.
**Gate F — launch:** operational training, support playbooks, backup restore drill, incident response, payment reconciliation and post-launch monitoring verified.

## Audit status
This is an initial design audit based on repository metadata, selected package manifests and OSS repository metadata. It is not a source-code audit of Laundry implementation: the Laundry repository was empty when first inspected. No product code or migrations have been implemented. OSS candidates are preliminary; license texts and source trees must be reviewed before reuse.