# Independent second-pass review — 2026-11-16

## Review method
Separate review against six lenses: role coverage, state consistency, finance/consent, operational feasibility, security/legal, and test specificity. Initial 800 cases were generated from 10 concrete actions per slice × five failure modes. This yields breadth but **does not mean 800 distinct business journeys**; many variants share a common test skeleton. Do not report these as 800 independently validated E2E flows.

## Findings and remediation
| ID | Severity | Finding | Remediation | Status |
|---|---|---|---|---|
| R01 | Critical | A single order.status cannot express delivered + payment disputed + missing item | Split lifecycle, custody, garment, payment, payable, claim and slot states | Documented in OPERATING_CONTRACTS |
| R02 | Critical | Economy tier could be misinterpreted as waiver of liability | Explicit statutory-rights guard and legal review gate | Documented in RU_LEGAL_RESEARCH |
| R03 | Critical | Price change after inspection may create unauthorized charges | Immutable quote snapshot and separate accepted adjustment | Documented |
| R04 | High | Paid off-schedule pickup/delivery could be charged when service caused missed slot | Fee waiver and fault attribution; no automatic surcharge | Documented |
| R05 | High | One scan by courier is insufficient proof of handoff | Dual-party scans, manifests and exception on discrepancy | Documented |
| R06 | High | Offline courier could falsely mark received | Local pending events with server validation and visible sync status | Documented |
| R07 | High | Partner and customer ledgers could be conflated | Separate receivables/payables, price versions and reconciliation | Documented |
| R08 | High | Splitting a batch can lose garment identity | Persistent garment lineage and bag re-assignment history | Documented |
| R09 | High | Overly broad partner access exposes home address and evidence | Role-scoped minimal fields and audit of media access | Documented |
| R10 | High | No distinction between 500 ₽ quoted fee and actual profitable cost | Route marginal-cost and fee version tracking | Documented |
| R11 | Medium | 800 scenario matrix is repetitive and lacks explicit fixtures/API per row | Agent must expand each case to test-ready Gherkin and concrete API assertions; separate E2E journeys below | Open for coding phase |
| R12 | High | Claims may be opened after delivery/closure | Claims independent of lifecycle; legal hold of evidence | Documented |
| R13 | High | No explicit fraud controls for claimed garment values | Pre-intake declaration, independent evidence, manual review; no unlawful denial | Documented |
| R14 | Medium | Price examples may be mistaken for approved tariff | Mark 500 ₽ as configurable hypothesis and require pilot margin test | Documented |
| R15 | Medium | Order cancellation and paid slot refund policies unspecified | Design policy matrix by fault, cutoff, service already rendered; legal sign-off | Open |
| R16 | High | No tested backup/restore or migrations yet | Expand/backfill/contract + restore drill and upgrade tests | Documented, not executed |
| R17 | Medium | Courier vehicle constraints not fully modeled | Add capacity by weight/volume, shift duration, access times, heavy loads | Open |
| R18 | High | A partner could contest invoice after payment | Preserve settlement revisions and debit/credit notes; no destructive edits | Documented |
| R19 | Medium | Quality rework can miss delivery SLA | Rework must re-estimate delivery and notify customer | Open |
| R20 | High | Late-night services can trigger labor/safety constraints | Availability rules by location, hours, safety and legal restrictions | Open |

## Cross-slice end-to-end journeys (minimum separate E2E suite)
E01 customer places Economy order → free building pickup → partner wash → free building delivery → payment and partner settlement.
E02 customer chooses Protected for one garment and Economy for the rest → separate manifests → one combined delivery.
E03 after booking, customer requests +500 ₽ special pickup → quote → consent/payment → capacity reservation → courier task.
E04 customer requests +500 ₽ special delivery after order ready → quote → consent/payment → new route → proof of delivery.
E05 both paid exceptions chosen → two separate fee lines → one combined invoice and receipts.
E06 partner reports actual weight different from quote → adjustment request → customer accepts → processing.
E07 customer declines weight adjustment → return without processing and lawful refund calculation.
E08 courier no-show due to operator fault → free rebooking, no fee.
E09 customer no-show → record attempt, apply only pre-agreed lawful reattempt rules.
E10 courier scans wrong bag → blocked assignment, incident and correction.
E11 courier offline → local queue → server sync → duplicate events ignored.
E12 bag seal broken on partner arrival → discrepancy, evidence, hold, investigation.
E13 partner discovers pre-existing damage → photo, customer approval or return.
E14 partner splits batch and repacks → garment lineage intact.
E15 garment missing at QC → partial fulfillment, claim, evidence hold, financial reconciliation.
E16 garment damaged → claim, review, compensation, partner liability allocation.
E17 customer alleges missing garment after delivery → trace custody and evidence.
E18 partner disputes wholesale invoice → line-level reconciliation and approved credit note.
E19 duplicate payment webhook → single capture, one receipt.
E20 partial refund and chargeback overlap → finance escalation, no double refund.
E21 user with partner role tries to view another partner's orders → denied and logged.
E22 legal retention expires while claim open → hold prevents deletion until lawful release.
E23 courier hands route to substitute → explicit custody transfer and new permissions.
E24 partner outage mid-processing → recovery and customer ETA adjustment.
E25 order partially delivered → outstanding positions visible and tracked.
E26 customer changes delivery address to another zone → new quote, consent, feasibility check.
E27 scheduled window cancelled due to low building density → transparent notice, alternative free window/refund.
E28 customer asks for night delivery but no safe capacity → no charge, offer next available slot.
E29 special pickup paid but courier cannot arrive → refund surcharge and rebook.
E30 customer reopens closed claim → preserve previous decision, new review record.

## Required next-phase deliverables
1. Turn each of 800 matrix entries into executable specification with fixture, API request, expected DB state, event, permission, notification and UI assertion.
2. Define complete role-permission matrix (action × resource × scope × field) and audit every portal.
3. Define finite state transition tables for all eight state machines, including compensating transitions.
4. Define pricing/fee policy table with who-caused-failure, cutoff, cancellation and refund rules.
5. Define partner commercial contract/settlement and customer cash-register model with Russian counsel.
6. Implement and test 30 cross-slice E2E journeys before declaring MVP ready.

## Independent-pass conclusion
**Status: foundation improved, NOT implementation-ready.** The first pass covers the main product areas; the second pass exposed policy gaps and test-detail gaps. No source code, CI, migrations, or UI has been executed. The matrix is a planning/test inventory rather than verified working behavior.