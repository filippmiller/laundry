# Laundry — independent open-source sourcing audit (2026-11-16)

Scope: courier pickup and delivery, routing, barcode intake, customer and partner portals, claims, invoices, accounting, Russian localization. GitHub repositories were searched and selected repository LICENSE files inspected. **Not** a code-security audit, license legal opinion, or benchmark. Maintenance recency/commit cadence, issue response, dependencies and exact release versions must be rechecked before adoption; 'not archived' alone is insufficient.

## Shortlist by module
| Slice | Candidate / URL | Stack / integration | License verification | Recommendation |
|---|---|---|---|---|
| Dispatch route optimization | VROOM https://github.com/VROOM-Project/vroom | native optimizer as isolated service, REST adapter | LICENSE inspected: BSD-style redistribution conditions | **P0 pilot**; benchmark grouped building stops and time windows |
| Routing and VRP alternative | GraphHopper jsprit https://github.com/graphhopper/jsprit | Java service, separate process | LICENSE path not found in quick inspection; verify repository license before copying | **P1 comparison**, not copy yet |
| Customer/admin/partner dashboards | Refine https://github.com/refinedev/refine | React/TypeScript framework, REST data provider | LICENSE inspected: MIT | **P0 preferred UI framework**, reuse components, enforce server-side RBAC |
| Dashboard alternative | React Admin https://github.com/marmelab/react-admin | React/TypeScript | LICENSE path not found in quick inspection; verify exact packages | **P1 comparison** |
| Internal operations console | Appsmith https://github.com/appsmithorg/appsmith | standalone low-code service, integration by API | LICENSE inspected: Apache 2.0; check subdirectories/dependencies | **P1 internal prototype**, not customer portal |
| Claims/customer support | Chatwoot https://github.com/chatwoot/chatwoot | separate Rails application + API/webhooks | LICENSE inspected: mixed licensing; enterprise directory differs | **P1 integrate**, do not wholesale copy |
| Accounting ledger | Bigcapital https://github.com/bigcapitalhq/bigcapital | accounting service reference | LICENSE inspected: AGPL-3.0 | **Study workflows; do not copy into proprietary app** without AGPL compliance review |
| ERP / partner invoice workflow | ERPNext https://github.com/frappe/erpnext | Frappe/Python, service integration | LICENSE path not found; independently verify license/version | **P1 integration evaluation**, not TS port |
| Invoicing UI/reference | Invoice Ninja https://github.com/invoiceninja/invoiceninja | Laravel backend, separate integration | LICENSE inspected: Elastic License 2.0 | **Reference only** pending commercial-use/legal review |
| Fleet GPS | Traccar https://github.com/traccar/traccar | independent tracking service | LICENSE path not found in quick inspection | **P2 optional**; privacy review required |

## Scanner and proof of delivery
Candidate scanapp-org/html5-qrcode ecosystem https://github.com/scanapp-org/html5-qrcode — verify canonical package and license before pinning; browser camera scanning can reduce hardware costs. Start with camera-based QR scan + manual fallback, offline event queue, bag/seal reconciliation and dual-party handoff; do not assume scanning a QR proves physical content. Driver and courier interfaces should be purpose-built React/PWA modules using shared TypeScript types. Barcode must contain only opaque IDs.

## Customer and finance dashboards
Use **one** React/TypeScript application with role-specific portals and server-side resource/field scopes, rather than porting a whole foreign ERP UI. Refine is strongest starting candidate for internal, partner and finance dashboards; customer portal should have a simpler custom checkout/tracking UX. Integrate accounting and invoicing via adapters, do not make the ERP database the source of truth for custody or customer consent.

## Russia-specific requirements and localization gates
- RUB integer kopeks, Russian UI, Moscow and regional timezones, localized address/building/entrance/apartment data, SMS/push templates.
- Client agreement and tariff versions, intake manifest, customer confirmation, complaint timeline, evidence retention and personal data rules under applicable Russian law.
- Fiscalization: determine merchant/agent structure and review 54-FZ requirements with local counsel/accountant; integrate a compliant Russian cash-register/OFD provider rather than reuse a foreign invoice PDF as a fiscal receipt.
- Partner accounting: act/invoice/UPD and electronic document interchange requirements depend on counterparty and tax model. Use document templates and adapter boundaries; don't claim a generic OSS invoice is Russian-compliant.
- Russian map/geocoding/routing providers require commercial license and data processing review; VROOM needs travel-time matrix from licensed source, not necessarily Google.
- Video evidence: consent/notice, access audit, minimization, retention/holds; no blanket contractual elimination of mandatory consumer rights.

## Build-vs-borrow decisions
**Borrow now:** MIT Refine UI foundation; prototype VROOM route optimizer via service adapter. **Integrate later:** Chatwoot for support, optional Appsmith for internal ops, ERPNext for partner back-office if viable. **Study, do not copy:** Bigcapital AGPL ledger and Invoice Ninja ELv2 invoicing. **Build as Laundry core:** custody event ledger, scan manifest, claims and valuation, customer order lifecycle, slot pricing and reservation, Russian fiscal adapter, partner settlement.

## Adoption gate for each repository
Check last tagged release and last 90-day commit activity, issue/PR responsiveness, security advisories, dependencies/SBOM, contributor concentration, package licenses (including subpackages), Russian localization and ability to deploy on user infrastructure. Create a minimal integration spike and verify tests before importing source. Record upstream URL, commit SHA, license text and notices in THIRD_PARTY.md. Do not copy GPL/AGPL/ELv2 code without legal review.

## Five-stage parallel sourcing plan
1. Candidate/license discovery and compatibility matrix (this document).
2. Adapter spike for route optimizer using sample grouped-building demand.
3. Refine role-based dashboard proof of concept with mock API and server-side authorization.
4. Russian fiscal/accounting adapter selection, evaluate provider documentation and partner document flow.
5. Security, license, performance and maintenance audit; select final pinned upstream versions.

This document completes stage 1 only. Stages 2–5 are implementation research gates, not falsely claimed as completed.
