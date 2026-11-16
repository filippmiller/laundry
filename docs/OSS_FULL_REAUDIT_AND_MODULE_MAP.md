# Laundry — full module re-audit and OSS integration architecture
Date: 2026-11-16. Design decision record; no third-party packages installed.

## Source of truth and architectural principle
The existing 16 slices/800 test inventory are a starting coverage model, not a full product. Use a **modular monolith** for Laundry transactional truth (PostgreSQL + Drizzle + TypeScript), with separately deployed optional OSS adapters. Never let an ERP, dashboard or optimizer mutate custody/finance state directly. Prefer maintained OSS with permissive licenses, direct TS compatibility, pinned versions and reproducible installs.

## Full block inventory (gap audit)
| Block | Core / external | Recommended path | Status / gap |
|---|---|---|---|
| Identity, sessions, organizations, permissions | Core | TypeScript server, scoped RBAC | Partial schema; auth missing |
| Service cities/zones, buildings/entrances | Core | Drizzle + address adapter | Partial schema; address normalization missing |
| Tariffs, economy/protected tiers, quotes | Core | versioned pricing engine | fee helper only |
| Slot capacity, scheduling, exceptions | Core | PostgreSQL atomic holds | partial code; incomplete authorization |
| Orders, line items, statuses, consent | Core | eventful order lifecycle | partial |
| Bags, seals, item manifests, weighing | Core | camera QR/PWA | schema seed; no flow |
| Video evidence, access/retention/legal hold | Core + object store | S3-compatible private media | missing |
| Courier shifts, stops, offline sync | Core + PWA | custom React/PWA | missing |
| Route optimization | external adapter | VROOM; matrix provider via OSRM or licensed maps | candidate; no integration |
| Hub, partner receipt, discrepancies | Core + partner portal | Refine-based UI | missing |
| Laundry production, batches, QC, rewash | Core | typed partner production module | missing |
| Customer portal, notifications, preferences | Core + messaging adapter | custom React; notification provider | missing |
| Dispatch, customer support, claims | Core + optional Chatwoot | Refine + separate helpdesk | missing |
| Customer billing, refunds, fiscal receipts | Core + provider adapter | Russian acquiring/KKT/OFD | missing |
| Partner invoicing, acts/UPD, reconciliation | Core + accounting adapter | Russian EDI/accounting integration | missing |
| Financial ledger, dashboards, margins | Core | immutable postings + Refine dashboards | missing |
| Data exports, compliance, consent/PD | Core | retention and audit module | missing |
| Monitoring, alerting, backups, disaster recovery | Infrastructure | structured logs/metrics | missing |
| Marketing, referral, building acquisition | Later | custom campaigns/attribution | missing |
| Subscription, recurring orders, loyalty | Later | domain modules | missing |
| Failed delivery, lost property, return to sender | Core | exception workflows | not sufficiently detailed |
| Partner SLAs, settlement holds, damage reserves | Core | contract rules | not sufficiently detailed |
| Fraud, high-value verification, claim review | Core | protected intake + evidence | not sufficiently detailed |
| Customer communication: SMS, push, email | Adapter | provider interface, templates | missing |
| Accessibility, Russian UX and support | Cross-cutting | ru-RU, RUB, local time | missing |

## OSS shortlist and actual stack checks
1. **Refine** https://github.com/refinedev/refine — inspected root package.json: TypeScript/React, pnpm/lerna monorepo; root LICENSE MIT. Use package dependencies for internal/partner/finance/admin dashboards; do not clone whole monorepo into Laundry.
2. **Ownfleet** https://github.com/Volodymyr4K/ownfleet — inspected package.json: TypeScript workspace, React 18, Node >=20, yarn; LICENSE MIT. **New promising candidate** for courier/dispatch UX and delivery workflow. Before reuse inspect API models, route proof, maintenance history and security. Prefer selective UI/flow adaptation rather than replace core.
3. **VROOM** https://github.com/VROOM-Project/vroom — inspected README: C++20 optimization engine, separate service; LICENSE BSD-style conditions. Keep out of Node process; use adapter HTTP service, travel-time matrix and fallback.
4. **Medusa** https://github.com/medusajs/medusa — inspected package.json TypeScript workspaces; root LICENSE MIT except enterprise materials. Potential source for order/cart/payment architecture but **not recommended as the primary Laundry engine**: physical custody, bag intake and partner production differ substantially from retail fulfillment. Selectively borrow patterns, not wholesale framework.
5. **Chatwoot** https://github.com/chatwoot/chatwoot — Rails service; mixed license including enterprise paths. Integrate by API/webhook, don't port.
6. **Appsmith** https://github.com/appsmithorg/appsmith — Apache 2.0 root license; standalone internal operations prototype only.
7. **Bigcapital** https://github.com/bigcapitalhq/bigcapital — AGPL-3.0 root; study accounting flows, no code copy into proprietary product without license compliance decision.
8. **Invoice Ninja** https://github.com/invoiceninja/invoiceninja — ELv2 root; not a safe copy-paste library. Foreign invoice formats are not Russian KKT fiscal receipts.
9. **Meteroid** https://github.com/meteroid-oss/meteroid — newly found, AGPL-3.0 root; subscriptions/billing reference, avoid code copying.
10. **Formbricks** https://github.com/formbricks/formbricks — mixed-license root; customer feedback optional, not critical path.
11. **OSRM** https://github.com/Project-OSRM/osrm-backend — routing engine candidate, license and deployment not yet independently verified; benchmark with local street network and legal map data.
12. **React Admin** https://github.com/marmelab/react-admin — UI alternative, exact package license not verified in this pass.
13. **ERPNext** https://github.com/frappe/erpnext — Python/Frappe ERP, integration candidate; not TS-portable without rewrite; exact license not verified in this pass.
14. **Traccar** https://github.com/traccar/traccar — optional fleet GPS; avoid always-on employee tracking without a documented necessity/privacy assessment.
15. **Novu** https://github.com/novuhq/novu — notification platform candidate; license and deployment not yet verified.
16. **shadcn/ui** https://github.com/shadcn-ui/ui — React UI components candidate; exact component license and dependency provenance require confirmation.

'Not archived' and successful repo search do not establish freshness, security or maintenance. Exact release date, last 90-day commits, dependency advisories and subpackage license remain adoption gates.

## Build / borrow / integrate
Build: booking/custody/intake/claims/financial truth/Russian legal rules. Borrow permissively licensed UI/utility components after audit. Integrate: VROOM route engine, Chatwoot support, optional tracking/notification and accounting adapters. Do not clone foreign ERP as system of record. Keep separate adapter process where language/license/deployment differs.

## Russian market gates
Legal review of consumer protection and inability to waive mandatory liability; no blanket 'undocumented item never existed' term. Personal data processing and video/retention under applicable rules, including 152-FZ and any localization obligations. Determine principal/agent role, KKT under 54-FZ, OFD, receipts for prepayment/refund/correction, tax treatment, and partner act/UPD/EDI as applicable. UI uses ru-RU, RUB minor units, timezones, local address structure, Russian support and document templates. No unsupported assertion of compliance.

## Installation readiness
- **Can start immediately in isolated spikes:** Refine example against mocked Laundry REST, Ownfleet architecture review and isolated build, VROOM container/adapter prototype, Medusa reference exploration.
- **Do not install as core dependencies yet:** ERPNext, Bigcapital, Invoice Ninja, Meteroid, Chatwoot until scope, license, operations and data-flow are approved.
- **Do not put vendor source into core:** keep `integrations/<vendor>` with pinned version and SBOM, or deploy separately.
- **No external repository has been downloaded or installed in this pass.** GitHub file/package inspections are remote-only.

## Second independent pass: omissions
Critical missing scenarios: pickup fails due to locked entrance; bag scan without physical possession; double seal assignment; partner receives wrong bag; untagged item found; water damage affecting multiple customers; item not washable; disputed declared value; client changes address after pickup; failed delivery with paid exception; offline scan reorder; consent withdrawn while evidence on legal hold; partial refund vs chargeback; fiscal receipt registration delayed; partner insolvency; courier shift abandoned; unavailable travel-time matrix; duplicate customer identity; shared apartment multiple customers; personal data deletion vs retention. All require scenario IDs and acceptance tests before release.
