# Laundry — PostgreSQL/Drizzle schema contract v3

Status: proposed schema, not implemented migrations. Use PostgreSQL, TypeScript, Drizzle. UUID keys, integer kopeks, UTC timestamptz, IANA city time zones, immutable snapshots, tenant scope and optimistic versioning.

## Migration groups and tables
001 Identity: organizations, users, memberships, roles, permissions, membership_roles, devices.
002 Geography: cities, service_zones, buildings, entrances, customer_addresses.
003 Catalog: services, service_restrictions, tariff_plans, tariff_versions, price_rules, partners, partner_contracts, partner_price_versions.
004 Scheduling: service_windows, slot_reservations, slot_exception_quotes, slot_exception_requests.
005 Orders: quotes, orders, order_lines, order_adjustments, customer_approvals, document_versions.
006 Items: garments, containers, seals, container_assignments, intake_manifests, intake_manifest_lines, garment_container_events.
007 Evidence/custody: scan_events, custody_events, custody_discrepancies, evidence_assets, evidence_access_events, evidence_legal_holds.
008 Processing: partner_receipts, batches, batch_items, processing_operations, quality_checks, partner_service_accruals.
009 Routes: courier_shifts, vehicles, routes, route_stops, delivery_attempts.
010 Customer finance: customer_invoices, customer_invoice_lines, payment_intents, payment_events, refunds, fiscal_receipts, ledger_accounts, ledger_journals, ledger_entries.
011 Partner finance: partner_invoices, partner_invoice_lines, partner_disputes, partner_credit_notes, partner_payouts.
012 Support: claims, claim_items, claim_decisions, compensations, support_threads, support_messages, notifications, audit_events, outbox_events, idempotency_records.

## Critical columns and constraints
orders: id UUID PK; organization_id FK; customer_id FK; address_id FK; quote_id FK; public_number; lifecycle_state; version bigint; timestamps. Unique (organization_id, public_number).
order_lines: id, order_id, service_id, tier, quoted_quantity numeric(12,3), actual_quantity numeric(12,3), quoted_amount_kopeks bigint, final_amount_kopeks bigint, tariff_snapshot_json JSONB, status.
garments: id, order_line_id, item_code unique, category, description, declared_value_kopeks nullable, condition_json, status, version.
containers: id, public_code unique, kind, active. seals: id, serial_number unique, status. container_assignments: id, container_id, order_id, assigned_at, unassigned_at. Exclusion: one active order per container.
intake_manifests: id, order_id, mode, count, weight_grams, customer_confirmation_id, manifest_hash. Immutable after acceptance; corrections are new records.
scan_events: id, device_id, client_event_id, actor_id, scanned_type, scanned_id, captured_at, received_at, payload_hash, sync_status. Unique (device_id,client_event_id).
custody_events: id, order_id, container_id, from_party, to_party, handoff_manifest_id, occurred_at, discrepancy_id. Append-only DB grants or trigger.
evidence_assets: id, organization_id, owner_type, owner_id, object_key, sha256, purpose, retention_until, legal_hold_count, status. No public object URLs.
service_windows: id, building_id, kind, starts_at, ends_at, is_shared, capacity_orders, capacity_weight_grams, status.
slot_reservations: id, service_window_id, order_id nullable, quote_id, expires_at, status, capacity_units, idempotency_key.
quotes: id, customer_id, tariff_version_id, expires_at, snapshot_json, total_kopeks, status.
customer_approvals: id, order_id, adjustment_id nullable, quote_hash, accepted_at, method, evidence_ref.
payment_events: provider, provider_event_id unique, payment_intent_id, event_type, payload_hash.
ledger_journals: id, source_type, source_id, posted_at, reversal_of. ledger_entries: journal_id, account_id, debit_kopeks, credit_kopeks; debit and credit nonnegative, not both positive; posting must balance per currency.
partner_service_accruals: id, partner_id, order_line_id, contract_price_version_id, quantity, amount_kopeks, status.
claims: id, order_id, claim_type, state, opened_at, due_at. claim_decisions: claim_id, version, outcome, rationale, approved_by.
idempotency_records: unique (organization_id,scope,key), request_hash, response_json, expires_at.

## Mandatory indexes
orders(organization_id,customer_id,created_at); orders(organization_id,lifecycle_state); custody_events(container_id,occurred_at); route_stops(route_id,sequence); claims(state,due_at); slot_reservations(service_window_id,status,expires_at); evidence_assets(owner_type,owner_id); partner_service_accruals(partner_id,status).

## Migration safety
Expand/backfill/contract; forward-only where reversal unsafe. Tests: fresh install, upgrade from prior schema, restartable backfill, concurrent slot reservation, immutable custody and finance, RLS/tenant isolation, balanced journal, duplicate webhook, legal hold. No SQL migration files have been created.
