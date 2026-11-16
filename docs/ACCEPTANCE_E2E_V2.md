# Laundry — executable-style E2E acceptance scenarios v2

This file provides detailed seed journeys for engineering. IDs E2E-001..012 are independent of the 800-case inventory. API paths are **proposed contracts**, not implemented endpoints.

## E2E-001 Economy + shared free pickup/delivery
Given customer C owns address A in active building B and partner P supports wash-by-weight; shared pickup slot S1 and delivery slot S2 have capacity; tariff T1 is published.
When C creates quote POST /quotes, selects S1/S2, accepts T1 and confirms POST /orders.
Then quote has pickup_fee=0 and delivery_fee=0; order confirmed with immutable price snapshot; capacity decreases once; receipt available; courier receives only assigned route data.
When courier scans bag G and seal L, captures intake and client confirms, then exactly one custody event is committed.
When partner receives, washes, QC passes and delivery proof is recorded, order delivered; payable accrues to P; no duplicate customer charges.
Assertions: order, bag, seal, manifest, custody events, ledger entries, partner payable, customer UI and notification.

## E2E-002 Paid off-schedule pickup
Given a feasible individual slot with fee 50000 kopeks.
When customer requests off-schedule pickup, then quote explicitly shows +500 ₽; no charge or confirmed route before consent.
When customer accepts and capacity commits, then exactly one surcharge line and pickup task exist; receipt reflects paid service.

## E2E-003 Paid off-schedule delivery
Given order ready and delivery outside shared window feasible.
When customer accepts +500 ₽ quote, then delivery task created and charge recorded once; shared pickup remains free.

## E2E-004 Both exceptions + duplicate request
Given customer accepts +500 ₽ pickup and +500 ₽ delivery.
When two identical POST requests arrive with same idempotency key, then one reservation and exactly two distinct surcharge lines totaling 100000 kopeks exist, not four.

## E2E-005 Protected item + Economy bag
Given customer declares one high-value jacket and everyday clothing.
When courier accepts, then jacket has individual garment_id, condition record and evidence; Economy bag has package-level manifest; no cross-assignment or mixed bag.

## E2E-006 Offline courier handoff
Given courier device loses network before scanning bag.
When scan events are captured locally and later synced twice, then server accepts each unique event once, verifies route assignment and state_version, and displays reconciliation exceptions on conflict; UI never claimed remote sync before ack.

## E2E-007 Broken seal at partner
Given manifest expects bag G seal L.
When partner scans a mismatched or broken seal, then automatic partner receipt completion is blocked; incident and evidence request created; dispatcher and claims notified; custody history unchanged.

## E2E-008 Price increase declined
Given partner inspection proposes additional service charge.
When customer declines, then no processing under revised terms; approved return workflow created; price snapshot unchanged; unrendered charges refunded under lawful policy.

## E2E-009 Lost garment, partial delivery
Given protected order with items I1/I2/I3.
When I2 is missing at QC, then I1/I3 can be delivered with item-level proof, I2 remains missing, claim opens, legal hold applies, order cannot be marked fully accounted without exception record.

## E2E-010 Partner settlement dispute
Given partner contract K version V, received weight W and completed operations O.
When partner invoice differs from expected wholesale lines, then payable becomes disputed; platform finance reviews, approves credit note and re-reconciles; customer price remains unchanged.

## E2E-011 Duplicate refund webhook and chargeback
Given customer captured 220000 kopeks and approved partial refund 50000 kopeks.
When refund webhook repeats and chargeback starts, then refund booked once, outstanding disputed balance reconciled and double payout blocked.

## E2E-012 Cross-partner access
Given partner users U1 in P1 and U2 in P2.
When U1 guesses P2 order, manifest, photo or invoice ID, then response denies existence safely, no data leaks, security audit recorded.

## Test fixture and automation contract
For every scenario: seed fixed clocks, currency RUB minor units, partner contracts, route capacity and user scopes. Use deterministic IDs; inspect API response, DB transaction state, outbox/event count, notification queue, UI state and authorization audit. Include fault injection for network/worker/payment provider. A test is complete only when runnable in CI with database reset and fake external providers.

## Remaining expansion
Generate Gherkin and API/DB assertions for all 800 cases after actual endpoint/schema decisions; do not claim they are implemented now.
