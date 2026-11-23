# Laundry — role, permission and data-scope matrix

## Roles
Customer, Courier, Driver (transport-only), HubWorker, LaundryOperator, LaundrySupervisor, PartnerFinance, Dispatcher, CustomerSupport, ClaimsInvestigator, ClaimsApprover, PlatformFinance, PlatformAdmin, SecurityAuditor, SystemWorker. Each user may hold multiple roles, scoped by organization/partner/city/shift. No role implicitly bypasses tenant isolation.

| Resource/action | Customer | Courier | Driver | Hub | Laundry | Dispatcher | Support | Claims | Finance | Admin |
|---|---|---|---|---|---|---|---|---|---|---|
| Order create/read | own | assigned read | assigned minimal | assigned minimal | assigned service-only | city | city | case-bound | billing fields | scoped |
| Edit pickup/delivery slot | own request | report exception | report exception | no | no | approve/assign | request | no | fee review | rules |
| Scan bag/seal | view own | assigned | route handoff | assigned | partner assigned | override with reason | read | read | no | audit |
| Create protected garment record | own draft | assigned intake | no | no | inspection update | no | no | evidence read | no | config |
| Record custody handoff | no | assigned | assigned | assigned | assigned | exception review | read | read | no | audit |
| Process garment/QC | no | no | no | no | assigned | monitor | no | case read | no | config |
| View video/photo | own limited | assigned intake | no | task limited | assigned processing | incident-limited | case-limited | case-limited | no | no by default |
| Change quoted price | request only | no | no | no | propose | capacity fee quote | propose | no | authorized adjustment | price rules |
| Issue refund | request | no | no | no | no | no | propose | recommend | approve within limits | dual-control |
| Create/resolve claim | own create/read | incident report | incident report | incident report | evidence response | incident report | triage | investigate/recommend | payout | no unilateral denial |
| Partner invoice | no | no | no | no | own partner view | no | no | disputed lines only | reconcile/pay | contracts |
| Configure tariffs | no | no | no | no | no | no | no | no | review | versioned publish |
| Access audit logs | own history | own actions | own actions | own actions | own actions | ops scoped | case scoped | case scoped | finance scoped | security role |

## Field-level security
- Client name, apartment, phone, door code: only assigned courier/dispatcher/support when necessary; laundry sees order ID and processing instructions, not apartment/door code.
- Declared item value: protected intake, claims and authorized finance only; partner only if necessary for acceptance.
- Media: short-lived signed URLs, no public buckets, every view/export logged, retention/hold enforcement.
- Payment tokens: never store card PAN/CVV; use provider tokens.
- Partner wholesale prices: partner finance sees own contract; customers do not see wholesale; platform finance sees all scoped contracts.
- Admin cannot bypass evidence retention or issue unlimited refunds alone.

## API enforcement
Authorization server-side at resource+action+scope+field; UI hiding is insufficient. Every query includes organization/partner/city scope, and test for IDOR by guessing another order ID. Assigned-route access expires after shift/assignment ends; offline device token has short TTL and limited scope. Sensitive actions require recent authentication, reason codes and, for large payouts/overrides, dual approval.

## Role acceptance tests
A. Each role can perform only listed actions on its own scope.
B. Every denied action returns safe error and writes security audit (without leaking object existence).
C. Cross-tenant, cross-partner and former-assignee requests are denied.
D. Claims evidence export requires active case and records purpose.
E. Admin role does not automatically grant claims investigator or media export rights.
