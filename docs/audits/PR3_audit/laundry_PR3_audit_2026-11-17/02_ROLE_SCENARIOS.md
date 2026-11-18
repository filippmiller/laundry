# Laundry — complete-by-construction scenario acceptance catalog

> **This is a test contract, not a completion certificate.** At audit HEAD no current-head suite was green. Every row starts as NOT_RUN_CURRENT_HEAD; the agent must connect actual code, status, test, CI evidence, and reviewer verdict. The scenarios are intentionally UNIQUE business actions. The five adversarial dimensions are applicability-driven, not automatically asserted as hundreds of passing tests.

**217 unique role/user/system scenarios** across 9 surfaces; **36 cross-role critical journeys**; up to 5 applicable fault/permission/retry dimensions. The existing `docs/SCENARIO_MATRIX_800.md` is a 160-action × five templated variants *design inventory*, not 800 executed tests. Do not substitute it for this role-specific list or falsely add counts.

## Acceptance discipline

For each scenario attach: actor + organization + partner + device; prerequisites/fixtures, exact endpoint/route, DB transitions, custody/ledger/outbox effects, UI state, negative authorization outcome, error/retry, stable test ID and Playwright evidence where applicable. Use status SPEC/UNIMPLEMENTED/UNIT_PASS/API_PASS/BROWSER_PASS/CROSS_ROLE_E2E_PASS/FAIL/BLOCKED/NOT_APPLICABLE; do not collapse them into a green checkbox.

## Test dimensions

- **V1:** Happy path + real positive outcome, state and audit
- **V2:** Invalid/expired/stale data and safe rejection
- **V3:** Unauthenticated, wrong actor, role, tenant and object authorization
- **V4:** Duplicate/idempotent, concurrency, offline retry, out-of-order events where applicable
- **V5:** Dependency failure, cancellation, dispute, compensation and recovery where applicable

## AU — Guest and authentication

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| AU-001 | P0 | Anonymous home/building landing | Shows supported locations and service terms without exposing private orders |
| AU-002 | P0 | QR referral/building entry | Opaque token resolves to allowed building; arbitrary token cannot reveal customer data |
| AU-003 | P0 | Address availability before account | Shows eligible service zone, timezone and windows without assuming eligibility |
| AU-004 | P1 | Guest quote preview | Clearly labels estimates and requires login/verification before committing customer order |
| AU-005 | P0 | OTP request | Sends challenge only through approved provider, rate-limited per IP/phone; never logs code |
| AU-006 | P0 | OTP verify | One valid unexpired single-use code establishes a scoped session; repeated/wrong attempt denied |
| AU-007 | P0 | OTP brute force | Attempt counter, cooldown and abuse alerts do not disclose whether phone exists |
| AU-008 | P0 | Concurrent OTP challenges | Only the current valid challenge/approved policy succeeds once |
| AU-009 | P1 | Session logout and revocation | Logout prevents new mutations; all tabs reflect revoked state |
| AU-010 | P0 | Multiple active devices | User can list/revoke only own sessions; lost device access blocked promptly |
| AU-011 | P0 | Role invitation | Staff role assigned only by permitted admin and invitation; no self-grant or arbitrary role flag |
| AU-012 | P1 | Suspended user | All API and offline reconnect actions reject suspended membership |
| AU-013 | P0 | Preview-mode access | Dedicated isolated demo tenant requires preview gate; no public role picker with real data |
| AU-014 | P1 | Missing phone provider | Registration blocked visibly, never pretends SMS sent |
| AU-015 | P0 | Cross-org identity | Same phone in multiple orgs cannot leak memberships, sessions or orders |
| AU-016 | P0 | Account recovery | Re-verification and audit; no insecure phone-only role escalation |
| AU-017 | P0 | Guest order tracking | Public number + authorized verification yields minimal status; wrong phone indistinguishable from missing |
| AU-018 | P1 | Accessibility and localization | Keyboard/mobile auth with Russian errors, labels, and reduced-motion behavior |

## CU — Customer

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| CU-001 | P1 | First order onboarding | Verified customer adds an eligible address and sees transparent next steps |
| CU-002 | P1 | Multiple addresses | Add/change/remove own addresses, validate building/entrance and references |
| CU-003 | P1 | Building unsupported | No order/charge; provide honest unavailable state and alternative |
| CU-004 | P1 | Economy wash by weight | Quote minor units and minimum rounding correct; bag-level evidence disclosure |
| CU-005 | P1 | Protected item-by-item | Item card, declared condition and agreed procedures recorded before intake |
| CU-006 | P1 | Mixed Economy and Protected | Two separate logical/physical containers; billed accurately and traced separately |
| CU-007 | P1 | Service catalog restrictions | Unwashable and excluded categories blocked with specific explanation |
| CU-008 | P1 | Customer chooses free shared pickup/delivery | Both legs hold capacity and fees are zero under versioned tariff |
| CU-009 | P1 | Customer chooses individual pickup | Feasible exception shown +500 RUB illustrative; explicit acceptance and unique fee line |
| CU-010 | P1 | Customer chooses individual return | Feasible delivery exception has separate consent and fee line |
| CU-011 | P0 | Both paid exceptions | Two independent fee lines; no duplicates on retry or payment timeout |
| CU-012 | P0 | Quote expires or price changes | Cannot confirm stale hash/terms; re-quote and consent required |
| CU-013 | P0 | Last-slot race | Only one booking succeeds with exact availability; no orphan charge |
| CU-014 | P1 | Checkout network timeout | Retry same request key resumes exactly one order and payment obligation |
| CU-015 | P0 | Fake payment declined/authorized/captured | Status distinct from actual fiscal receipt; no false paid banner |
| CU-016 | P0 | Invoice/receipt download | Customer may print signed provisional document; full legal requisites or blocked disclaimer |
| CU-017 | P0 | Order history and timeline | Shows only own orders and sanitized events on desktop/mobile |
| CU-018 | P1 | Reschedule two legs | Atomic swap preserves old booking on failed second leg and sends notice |
| CU-019 | P0 | Cancel before dispatch | Release capacity, compute lawful refund/fees, preserve audit history |
| CU-020 | P0 | Cancel after pickup | Returns possessions with custody proof, legal policy decision and independent refund |
| CU-021 | P0 | Partner proposes additional service | Customer sees delta, reason, expiry, and choices without forced charge |
| CU-022 | P1 | Customer accepts adjustment | Versioned consent binds new price and processing; updated invoice/payment reconcile |
| CU-023 | P1 | Customer declines adjustment | No processing under altered terms; return-unprocessed is an actionable path |
| CU-024 | P1 | Delivery tracking and ETA change | Shows real state not fabricated route ETA; notifies delays |
| CU-025 | P0 | Delivery to wrong recipient | Proof/recipient mismatch blocks closure and opens incident |
| CU-026 | P0 | Missing or damaged garment | Claim linked to correct item, custody, evidence and statutory remedy review |
| CU-027 | P0 | Partial delivery then recovery | Outstanding garment visible, reattempt order created and one final reconciliation |
| CU-028 | P0 | Request cancellation/refund dispute | Clear support SLA and ledger/fiscal references; no self-issued refund |
| CU-029 | P0 | Review after real delivery | Only eligible delivered order reviewed, moderation reason and audit visible |
| CU-030 | P1 | Support conversation | Create own-order ticket, respond, reopen and preserve message history |
| CU-031 | P1 | Notification preferences | Opt-ins and transactional essential notices separated; failed delivery honest |
| CU-032 | P1 | Repeat order | Prepopulate old service but require new tariff, quote and capacity acceptance |

## CO — Courier and driver

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| CO-001 | P0 | Accept assigned shift | Authenticated courier sees only own valid shift and vehicle |
| CO-002 | P0 | Reject conflicting shift | Overlapping shift/vehicle assignment safely blocked |
| CO-003 | P0 | Assigned stop list | Only assigned active pickup/return stops, ordered by real route and windows |
| CO-004 | P1 | Route navigation | Valid real building location and road route; no hashed synthetic distances |
| CO-005 | P0 | Arrive at stop | Assigned actor and shift, version guard, exact arrival audit |
| CO-006 | P0 | Customer absent for pickup | Failed attempt with reason and rebook path; no false custody transfer |
| CO-007 | P1 | Locked entrance / denied access | Operator incident and consent-safe contact fallback |
| CO-008 | P0 | Scan order QR | Opaque signed/validated identifier, no secrets/PII encoded, assignment checked |
| CO-009 | P0 | Scan bag and seal | Container and seal belong to same assigned order, unique and available |
| CO-010 | P1 | Economy bag weigh | Scale/manual fallback recorded, numeric bounds checked, customer confirms bag count |
| CO-011 | P0 | Protected condition capture | Item scan, care labels and private photos linked to signed manifest |
| CO-012 | P1 | Mixed order pickup | Protected and Economy items physically separated and recorded |
| CO-013 | P1 | Two-party handoff | Customer and courier independently confirm manifest/version/weight/ID |
| CO-014 | P0 | Customer disputes count | No automatic acceptance; incident, pending custody and documented resolution |
| CO-015 | P1 | Camera permission denied | Manual code entry with equal server validation |
| CO-016 | P1 | Offline store then page reload | Queue persists, explicit UNSYNCED state; no remote-success claim |
| CO-017 | P1 | Offline out-of-order events | Server validates state/version and responds per-event acceptance/conflict |
| CO-018 | P0 | Duplicate or modified scan replay | Idempotent once; changed payload/hash/actor/device fails |
| CO-019 | P0 | Device stolen or reassigned | Revoked device cannot post new scans; old queued scans segregated |
| CO-020 | P0 | Transfer to hub/partner | Receiver co-signs, broken seal/missing bag blocks auto custody |
| CO-021 | P0 | Pickup after cancellation | Old stop assignment invalidated; no custody event created |
| CO-022 | P0 | Delivery manifest pickup | Only ready accounted containers assigned to driver |
| CO-023 | P1 | Delivery to customer | Recipient proof tied to correct package/item set |
| CO-024 | P0 | No-answer delivery | Secure custody kept; return/reattempt slot and exception created |
| CO-025 | P1 | Customer refuses delivery | Reason and return-to-hub workflow; no delivered status |
| CO-026 | P0 | Partial delivery | Outstanding items/containers and next stop created without double delivered state |
| CO-027 | P0 | Shift abruptly abandoned | Dispatcher alerted; remaining stops reassigned with new permission boundary |
| CO-028 | P0 | Complete shift and reconcile | No unresolved physical custody or unsynced scans silently ignored |
| CO-029 | P0 | Driver transport-only mode | No protected item edit or finance access; minimal location/contact data |
| CO-030 | P1 | Battery/network failure mid-confirm | Resume with same idempotency, no phantom handoff |

## PA — Laundry partner

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| PA-001 | P0 | Partner account/login | Only invited assigned partner members access partner portal |
| PA-002 | P0 | Expected inbound queue | Shows only orders explicitly assigned to this partner |
| PA-003 | P0 | Order unassigned or belongs to partner B | No claim by first scan; safe 404 and audit |
| PA-004 | P1 | Receipt by bag and seal | Independent receiver scan matches courier manifest and transfer proof |
| PA-005 | P1 | Broken or reused seal | Incident and hold, no silent accept |
| PA-006 | P1 | Weight discrepancy | Measured vs expected stored; price delta needs customer consent |
| PA-007 | P0 | Wrong bag in batch | Cross-order or partner mismatch rejected before processing |
| PA-008 | P1 | Protected item condition inspection | Care label, known defects and evidence associated with each item |
| PA-009 | P0 | Unsupported cleaning method | Request customer decision or return-unprocessed without substitute method |
| PA-010 | P1 | Customer approves change | Immutable updated price/technology consent and invoice/reconciliation |
| PA-011 | P0 | Customer refuses change | No new work, safe packing/return task, refund review |
| PA-012 | P1 | Inspection while customer unreachable | Hold pending approval, SLA timer and escalation; no default consent |
| PA-013 | P0 | Create processing batch | Only accepted assigned garments; record recipe/technician/start time |
| PA-014 | P1 | Batch across multiple orders | Item identities preserved, no mixup of two customers |
| PA-015 | P0 | Partial batch completion | Remaining items tracked; cannot mark entire order ready |
| PA-016 | P1 | QC passes all items | Exact expected set and bag-level rules satisfied before packing |
| PA-017 | P1 | QC fails / needs rewash | State returns to processing, no unjustified customer fee, ETA updated |
| PA-018 | P0 | Lost item after processing | Mark missing, seal evidence, claim and partial fulfillment; cannot silently close |
| PA-019 | P0 | Damage discovered in processing | Evidence, incident and authorized compensation analysis |
| PA-020 | P1 | Ready-for-return packing | Verified output manifest, new bag/seal and courier receiving proof |
| PA-021 | P0 | Partner unavailable or SLA breach | Dispatcher gets escalated backlog; customer revised schedule/compensation |
| PA-022 | P0 | Partner invoice period | Only own accruals, immutable contract price version and correct quantity |
| PA-023 | P0 | Partner disputes line | Only own line, evidence and separate credit note approval |
| PA-024 | P0 | Partner finance vs operator | Operator cannot see platform-wide revenue or other partners' invoices |
| PA-025 | P0 | Partner operator leaves company | Session/device revoked and pending tasks safely reassigned |

## DI — Dispatcher and operations

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| DI-001 | P0 | Read dashboard | Shows scoped queues/counts without customer sensitive fields |
| DI-002 | P1 | Create/configure building windows | Geography, shifts and capacity verified; changes audited |
| DI-003 | P0 | Capacity concurrent booking | No oversell despite two customers; stale counters reconciled |
| DI-004 | P1 | Plan courier shift | Vehicle, person, legal working hours and region compatible |
| DI-005 | P0 | Assign pickup to courier | Exactly one active stop, correct order state and shift |
| DI-006 | P1 | Assign laundry partner | Partner contract/zone/capacity check precedes partner receipt |
| DI-007 | P0 | Grouped house pickup | Cluster compatible windows without fake distance claims |
| DI-008 | P1 | Optimized route proposal | Real geocoding/matrix, window/weight feasibility, auditable comparison |
| DI-009 | P0 | Manual route override | Versioned planner reason, valid handoffs, no silent custody edit |
| DI-010 | P0 | Router/optimizer outage | Fall back to safe manual plan without misleading ETA |
| DI-011 | P1 | Late courier | Customer notified and dispatcher offered reassignment/reschedule |
| DI-012 | P0 | Courier no-show | Assigned stops requeued and legal off-schedule fee waived if operator fault |
| DI-013 | P1 | Customer no-show | Proof/attempt and lawful policy, no invented penalty |
| DI-014 | P1 | Reassign stop after shift cancelled | Previous device loses access, queued scans reconciled |
| DI-015 | P0 | Partner rejects inbound handoff | Incident assigned, custody remains with correct holder |
| DI-016 | P1 | Partner SLA breach | Capacity and downstream return plans updated |
| DI-017 | P1 | Protected special delivery | Premium capacity and second charge/consent tied to actual route |
| DI-018 | P0 | Partial delivery recovery | Outstanding garments/containers generate a real next stop |
| DI-019 | P1 | Recipient unavailable | Safe storage, reattempt window and customer contact |
| DI-020 | P0 | Returns without processing | Physical return chain created after declined adjustment |
| DI-021 | P1 | No supported partner available | Do not sell booking; operational exception with clear customer response |
| DI-022 | P0 | Safety and physical custody anomaly | Stop processing, create claim/investigation and audit resolution |
| DI-023 | P0 | Cross-city dispatcher | Cannot silently access unrelated tenant/city or partner contracts |
| DI-024 | P1 | Dispatch completion metrics | Real on-time %, cost per stop and backlogs from persisted events |

## SU — Support and claims

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| SU-001 | P0 | Search customer by public number | Scoped exact match with minimal customer contact fields |
| SU-002 | P1 | Open support thread | References an owned order and immutable participant trail |
| SU-003 | P1 | Respond to ticket | Correct participant, no cross-tenant messages, audit timestamp |
| SU-004 | P1 | Close/reopen thread | Permissions and state history preserved |
| SU-005 | P0 | Open missing-item claim | References only real garment of order; legal hold on its assets |
| SU-006 | P1 | Open damage claim | Retains pre-intake and post-QC evidence and treatment history |
| SU-007 | P0 | Claim without photos | Accept statutory complaint, request further evidence without unlawful blanket refusal |
| SU-008 | P1 | Cross-order evidence ID | Reject object-level references, no exposure of storage keys |
| SU-009 | P0 | Investigation assignment | Case-based role access with expiry and access audit |
| SU-010 | P0 | Decision and rationale | Approver authorized; prior decisions immutable, support cannot self-approve |
| SU-011 | P0 | Appeal/reopen | Adds revision and review, never overwrites previous denial |
| SU-012 | P0 | Partial lost/returned items | Physical exception and financial remedy linked without forced closure |
| SU-013 | P0 | Compensation proposal | Support recommends, finance approves and payout separate |
| SU-014 | P1 | Customer retracts consent | Consent record and lawful retention hold handled correctly |
| SU-015 | P1 | Evidence export | Justified access, short-lived URL, watermark and audit, no partner-wide leak |
| SU-016 | P0 | Retention expiry while case open | Legal hold prevents deletion and grants are time bounded |
| SU-017 | P0 | Customer requests data deletion | Lawful retention matrix, erase only unheld data with export/audit |
| SU-018 | P0 | Response SLA escalation | Reminders and assignment on overdue ticket without fabricated delivery |
| SU-019 | P1 | Suspicious repeat claims | Fraud signal informs review, never auto-denies statutory claim |
| SU-020 | P1 | Support employee leaves | Revoke case access/session while preserving case audit |

## FI — Finance and settlement

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| FI-001 | P0 | See finance dashboard | Only finance staff, real scoped amounts, no unapproved metrics |
| FI-002 | P1 | Quote and invoice | Line totals, version snapshots, tax/legal label and rounding match |
| FI-003 | P0 | Fake payment capture | One obligation/one posting; no real-acquiring claim |
| FI-004 | P0 | Duplicate capture with new key | Unique obligation guard prevents second payment |
| FI-005 | P1 | Provider webhook validation | Verified signature, timestamp/replay and intent/tenant/amount mapping |
| FI-006 | P1 | Provider event retried | Exactly-once business posting and no extra fiscal document |
| FI-007 | P1 | Provider event delayed/out of order | State machine defers/applies safely with reconciliation |
| FI-008 | P0 | Two simultaneous refunds | Sum never exceeds net captured under row locking |
| FI-009 | P0 | Refund and chargeback race | Financial hold prevents double payout and records provider truth |
| FI-010 | P0 | Partial service refund | Unrendered service credited, delivered portion accounted and consent preserved |
| FI-011 | P0 | Cancellation fees | Only legal documented costs; off-schedule failure refunded if operator fault |
| FI-012 | P0 | Price adjustment accepted | New invoice line/debit note posted only after consent and service |
| FI-013 | P0 | Price adjustment declined | No delta charge; cancellation/return and refund examined |
| FI-014 | P0 | Ledger journal balance | Every journal balanced, immutable entries, idempotent posting and reversals |
| FI-015 | P1 | Customer invoice PDF/print | Correct customer and legal requisites, demo label where applicable |
| FI-016 | P1 | Fiscal receipt pending | Explicit pending until KKT/OFD provider ack; failed/retry alert |
| FI-017 | P0 | Fiscal refund/correction | Independent lawful fiscal state and provider reconciliation |
| FI-018 | P0 | Partner accrued services | Contract version, quantity, acceptance and nonduplicated basis |
| FI-019 | P1 | Partner disputed invoice | Dispute and credit note before approved payment, original line preserved |
| FI-020 | P0 | Partner payout approved | Two-person control threshold and provider idempotency; money not moved in fake mode |
| FI-021 | P0 | Compensation approved | Separate payable and actual transfer reconciliation; approval alone not paid |
| FI-022 | P0 | End-of-day reconciliation | Capture/refund/chargeback/cash receipt and provider differences visible |
| FI-023 | P1 | Margin by building and route | Real partner/courier/fuel/fees allocated; no invented profitability |
| FI-024 | P1 | Finance export | Audited, least privilege, redacted report with consistent totals |

## AD — Administration, security and compliance

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| AD-001 | P0 | Platform admin sign-in | Invited MFA/OTP session and no demo role picker in real environment |
| AD-002 | P0 | Grant role | Only authorized admin, reason required, audit and no self-elevation |
| AD-003 | P0 | Revoke role | Current session and access revoked; last-admin guard holds under concurrency |
| AD-004 | P0 | Suspend employee | No self lockout, no last active admin lockout, all devices expire |
| AD-005 | P0 | Partner invite and scope | PartnerId not user-supplied; restrict to contract/service area |
| AD-006 | P0 | Admin lists memberships | Tenant-scoped with pagination and sensitive-field minimization |
| AD-007 | P1 | Admin revoke sessions | Target belongs to tenant, audit reason, immediate effect |
| AD-008 | P1 | Configure service catalog | Versioned service restrictions/availability and test quote |
| AD-009 | P1 | Publish tariff version | Two-step approval, effective dates, no retroactive existing quote edit |
| AD-010 | P1 | Configure premium surcharge | Approved price/feasibility, transparent customer line and audit |
| AD-011 | P1 | Configure city/building | Validated address/timezone/real geocoding and service zone |
| AD-012 | P0 | Configure partner contract | Legal/SLA, wholesale versions and role boundaries |
| AD-013 | P0 | Configure notifications | Templates, provider approved, privacy opt-out and delivery audit |
| AD-014 | P0 | Configure retention schedule | Purpose/category, legal hold, documented owner sign-off |
| AD-015 | P1 | Configure KKT/payment providers | Secrets outside repo, real vs fake flags and dry-run verification |
| AD-016 | P0 | Inspect fraud queue | No automatic adverse determination, scoped investigation and appeal |
| AD-017 | P0 | Audit event search | Append-only and field-redacted, correlated request and user |
| AD-018 | P1 | Secure media access | Case-based and logged; admin not automatically able to browse all videos |
| AD-019 | P0 | Restore operation | Off-host backup, clean-instance restore, access and ledger reconciliation |
| AD-020 | P0 | Permission matrix audit | Every route/action/field denied by default to wrong tenant/role |
| AD-021 | P1 | Feature flags rollout | Canary/risk-limited activation, rollback and identical SHA evidence |
| AD-022 | P0 | Security incident | Contain affected account/provider, revoke keys, retain forensic evidence |
| AD-023 | P0 | User data export/deletion | Privacy request tracked with lawful holds and actor audit |
| AD-024 | P0 | Configuration change race | Two admins cannot unknowingly overwrite critical versions |

## OP — Platform, workers, and production operations

| ID | Priority | Unique scenario | Required acceptance |
|---|---|---|---|
| OP-001 | P1 | Fresh-install migrations | PostgreSQL 16 migration chain succeeds and schema drift check clean |
| OP-002 | P0 | Upgrade populated DB | Upgrade preserves orders, custody, ledger, future-compatible columns |
| OP-003 | P1 | Rollback strategy | No destructive implicit schema revert; rehearsed app/data rollback plan |
| OP-004 | P1 | Backup on different host | Actual pg_dump/pg_restore or verified PITR, not same-instance template clone |
| OP-005 | P1 | Application liveness | GET /health returns fast process health |
| OP-006 | P1 | Application readiness | GET /health/ready checks DB/migrations and Compose reaches healthy |
| OP-007 | P1 | Outbox retry under failure | Backoff, dedupe, DLQ, no notification lost or double-sent |
| OP-008 | P1 | Payment inbox crash halfway | Atomic per-event processing and safe replay after process kill |
| OP-009 | P0 | Worker concurrency | FOR UPDATE SKIP LOCKED and recovery from stuck processing |
| OP-010 | P0 | Scheduler expiry vs confirmation | Held slot expires once; confirmed order cannot be released by TTL |
| OP-011 | P1 | Cross-tenant query scanner | Every new GET and mutation carries org/resource/actor projection tests |
| OP-012 | P0 | Rate limit and abuse | OTP/search/tracking/preview/webhooks appropriate per-client controls |
| OP-013 | P0 | API contract generated from actual routes | OpenAPI has reliable methods, responses, role and optional param status |
| OP-014 | P1 | Frontend route contract CI | No UI import/mount references an unregistered endpoint |
| OP-015 | P0 | Browser E2E all roles | Six+ role journeys in Playwright mobile/desktop with screenshots/traces |
| OP-016 | P0 | Courier offline realistic | IndexedDB persists reload and duplicate/reorder/revoked-device sync tests |
| OP-017 | P1 | Drill artifacts hygiene | No raw DB, WAL, secrets, PII or local cache in Git/PR artifact |
| OP-018 | P0 | Third-party license provenance | Pinned version/commit, licenses, notices, SBOM and security |
| OP-019 | P0 | Metrics and alerts | Real SLA, failed queues, refund drift, custody mismatches, latency and backup age |
| OP-020 | P1 | Release/soak | Exact SHA, smoke/evidence, rollback, approval gates and monitored pilot |

## Mandatory cross-role journeys

| ID | Unique end-to-end journey | Roles |
|---|---|---|
| F01 | Economy building pickup → partner wash → QC → shared delivery → close | customer,courier,partner,dispatcher,finance |
| F02 | Protected jacket + Economy bag separated → itemized QC → combined return | customer,courier,partner,dispatcher |
| F03 | Both +500 RUB illustrative exceptional trips → consent → feasible route → one invoice | customer,dispatcher,courier,finance |
| F04 | Two concurrent customers compete for last pickup slot | customer,platform |
| F05 | Reservation expires while payment pending; compensation void/refund | customer,finance,platform |
| F06 | Client reschedules pickup and delivery; second new hold fails; old holds intact | customer,dispatcher |
| F07 | Cancel after dispatch before handoff → remove courier stop + lawful refund | customer,dispatcher,courier,finance |
| F08 | Cancelled order scanned later by offline courier → reject stale event | customer,courier,dispatcher |
| F09 | Customer missing at door → proof → operator rebooks without false custody | courier,dispatcher,customer |
| F10 | Wrong seal at partner receipt → dispute pending, custody not transferred | courier,partner,dispatcher,support |
| F11 | Protected garment mislabelled and moves to another customer's batch → block | partner,dispatcher,claims |
| F12 | Partner weight adjustment accepted → revised invoice and processing | partner,customer,finance |
| F13 | Partner adjustment declined → return without processing + refund decision | partner,customer,courier,dispatcher,finance |
| F14 | QC failure → rewash → new ETA and notification → successful delivery | partner,dispatcher,courier,customer |
| F15 | Partner outage → reassign pending contracted orders, custody safe | partner,dispatcher,admin |
| F16 | Item lost while other items ready → partial delivery → claim and compensation | partner,courier,customer,claims,finance |
| F17 | Customer recipient unavailable → secure return + repeat delivery | courier,dispatcher,customer |
| F18 | Customer reports missing item after closure → reopen claim + legal hold | customer,support,claims |
| F19 | Phone/device revoked while courier offline → no unauthorized sync | courier,admin,platform |
| F20 | Offline scan captured → browser reload → reconnect unordered → dedup/conflict | courier,platform |
| F21 | Partner B attempts partner A's manifest, evidence and finance dispute | partner,finance,security |
| F22 | Customer B attempts customer A's order, invoice, claim and media IDs | customer,security |
| F23 | Refund two different keys simultaneously, both full; only one granted | finance,platform |
| F24 | Refund and chargeback cross at ledger posting; no double payout | finance,platform |
| F25 | Payment webhook duplicate and out-of-order; fiscal still pending until provider ACK | finance,platform |
| F26 | Partner disputes accrual and gets an approved credit note; history preserved | partner,finance |
| F27 | Compensation proposed by support → dual-approved finance → fake settlement | support,finance,customer |
| F28 | Data deletion request during active claim hold; lawful held data remains | customer,support,admin,privacy |
| F29 | Admin revokes role and session mid-request; next mutation fails | admin,security,platform |
| F30 | Two admins concurrently attempt to remove last active admin; lockout prevented | admin,security |
| F31 | Routing engine unavailable; manual plan with true data, no fictitious ETA | dispatcher,courier |
| F32 | Large night/off-schedule request exceeds safe route capacity; no charge | customer,dispatcher,finance |
| F33 | Disaster recovery: migrate, pay(fake), claim, backup, destroy, restore, reconcile | platform,finance,support |
| F34 | Two tenants share phone number; sessions/orders/media/ledger cannot cross | customer,admin,security |
| F35 | Public guest tracking guesses wrong phone; no order existence or PII leak | guest,security |
| F36 | Realistic multi-house pickup load: route, partner capacity, SLA margin and returns | customer,courier,partner,dispatcher,finance |

## Coverage exit gates

- At least one real interactive browser journey per major role (guest, customer, courier, partner, dispatcher, support/claims, finance, admin); role switching must not hide backend 403s.
- E2E-001..012 from the original PR plus F01..F36 above must be runnable on disposable PostgreSQL with real API and browser/hardware simulation where appropriate. Any blocked case retains a named blocker and owner.
- Every HTTP route must have a role/resource/field and negative-authorization mapping. Every state mutation must have idempotency and consistency assertions. No fake count/OTP/payment/notification/route metric is accepted as delivered.
- Complete a risk-weighted subset first (P0), then all P1 journeys. A 100%-complete label is allowed only when agreed scope, current-head CI, and independent review agree; do not conflate 'documented' with 'implemented'.
