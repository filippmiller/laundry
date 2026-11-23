# Lane D report — Evidence ABAC: close the cross-tenant evidence IDOR

Status: **DONE_WITH_CONCERNS** (see "Concerns" below — the only open items are a schema gap I was
forbidden to fix and a pre-existing false entry in `REMEDIATION_PROGRESS.md`).

Scope of this lane: `src/services/workspace.ts` + `test/security/**`. No other file was modified;
nothing was committed, staged or pushed.

---

## 1. Ownership rules implemented (per owner type)

Deny by default. Every rule resolves the **owner object** inside the principal's tenant
(`organization_id = principal.organizationId`); a foreign tenant, a missing object and an owner
type without a rule all end in `NOT_FOUND` (existence is not leaked).

| owner type | who is entitled | rule (source) |
|---|---|---|
| `order` | the order's customer (`orders.customer_id = principal.userId`) | `entitledToOrder()` — `src/services/workspace.ts:127-133` |
| `order` | tenant staff: `customer_support`, `claims_investigator`, `claims_approver`, `platform_admin`, `dispatcher` (unchanged staff scope of this file) | `isEvidenceStaff()` — `src/services/workspace.ts:106-108` |
| `order` | `laundry_operator` **only** if custody was assigned to that partner (`orders.assigned_partner_id = principal.partnerId`) | `entitledToOrder()` — `src/services/workspace.ts:131` |
| `claim` | a customer who opened the claim (`claims.opened_by = principal.userId`) **or** who owns the claim's order | `resolveEvidenceOwnership()` — `src/services/workspace.ts:149-163` |
| `claim` | tenant staff (same staff scope as above) | `src/services/workspace.ts:155` |
| `claim` | a partner assigned to the claim's order | `src/services/workspace.ts:162` |
| `custody_event` | the customer of the custody event's order, the partner assigned to that order, tenant staff | `src/services/workspace.ts:164-172` |
| anything else (`garment`, unknown strings) | nobody — **denied** | `src/services/workspace.ts:173` |
| any owner, wrong tenant | nobody — **denied** (`NOT_FOUND`) | `authorizeEvidenceOwner()` — `src/services/workspace.ts:181-189` |

Deliberate rule change: the uploader (`evidence_assets.created_by`) no longer gets an implicit
right. Previously `asset.createdBy === principal.userId` alone authorised access, which would let a
partner keep reading evidence of an order whose custody was later moved to another partner. Access
now follows the owner object only.

Role notes: `laundry_operator` was previously lumped into the blanket "staff" shortcut in this file
and therefore could read *every* order's evidence in the tenant. That shortcut is gone; partners are
scoped by assignment now. `ROLE_GROUPS.partner` (`laundry_operator`, `laundry_supervisor`,
`partner_finance`) is used for the partner rule, but `assertRole` on the evidence entry points
still admits only `laundry_operator` of those roles, as before.

---

## 2. Changes, with exact file/line

### `src/services/workspace.ts`

| line | change |
|---|---|
| 1-8 | import `ne` from `drizzle-orm`; import `custodyEvents` from `../db/schema.js` |
| 95-101 | new `TOMBSTONE_STATUS = "expired"` (see schema gap below) |
| 103-124 | new `EvidenceOrderScope`, `isEvidenceStaff()`, `isEvidencePartner()`, `loadScopedOrder()` (tenant-scoped order lookup) |
| 126-133 | new `entitledToOrder()` — customer / tenant staff / assigned partner |
| 135-174 | new `resolveEvidenceOwnership()` — per-owner-type rules, deny by default |
| 176-189 | `authorizeEvidenceOwner()` rewritten: tenant check + owner-object entitlement, no `createdBy` shortcut |
| 195-228 | `registerEvidence()`: the order-only owner validation is replaced by `resolveEvidenceOwnership()` for **all three** owner types (`src/services/workspace.ts:211-213`); a foreign claim/custody owner now fails with `NOT_FOUND` |
| 230-258 | `listEvidence()`: entitlement check before listing (`232-234`); `objectKey` is no longer selected (`237-244`), so no route can leak it; tombstoned assets are filtered out (`249`) |
| 260-297 | **new** `readEvidence()` — single-asset read with the same object-scoped rule, no storage key, tombstoned asset not served, access event logged |
| 299-351 | `deleteEvidence()`: object-scoped authorisation (`318`); legal hold still refuses (`320-330`); the deletion of `evidence_access_events`, `evidence_legal_holds` and the asset row is **removed**; the asset is tombstoned instead (`332-340`); the audit event no longer carries the storage key but the digest (`341-348`) |

### `test/security/evidence-abac.integration.test.ts` (new)

13 tests, listed in section 3.

---

## 3. Tests

File: `test/security/evidence-abac.integration.test.ts` (13 tests, all passing).
Fixture conventions follow `test/security-regressions.integration.test.ts` (`seedFullOrder` from
`test/operations-fixtures.ts`, `makePrincipal`/`seedAddress` from `test/fixtures.ts`, `app.inject`
against the real Fastify app, `demo-login` sessions).

Negative tests (each asserts HTTP status + `error.code`, never message text):

1. `a customer cannot list another customer's claim evidence` — 404 / `NOT_FOUND`, body free of the
   foreign `objectKey` and evidence id.
2. `a customer cannot list another customer's custody event evidence` — 404 / `NOT_FOUND`.
3. `a customer cannot read a specific evidence id that belongs to another customer` —
   `readEvidence` and `deleteEvidence` on the foreign asset both reject with `NOT_FOUND`; the foreign
   asset is untouched.
4. `a laundry partner cannot read the evidence of an order assigned to another partner` — 404 for the
   unassigned partner; the *assigned* partner still gets 200 (no over-blocking).
5. `a user of another tenant is denied` — 404 / `NOT_FOUND`, no key, no id in the body.
6. `the storage key never appears in a customer or partner listing` — asserts on the **serialised
   response body**: neither the `objectKey` value nor the string `objectKey` appears.
7. `an unauthenticated evidence request is rejected` — 401 / `UNAUTHORIZED`.
8. `evidence registration for a foreign owner is refused` — registering against a foreign claim and a
   foreign custody event both reject with `NOT_FOUND`.
9. `an owner type without a resolved rule is denied` — `listEvidence(..., "garment", ...)` and an
   unknown order id both reject with `NOT_FOUND` (deny by default).
10. `a customer of another tenant cannot delete evidence` — rejects with `NOT_FOUND`, asset and order
    assignment unchanged.

Positive tests:

11. `the owner lists their own evidence` — 200, exactly their own asset, digest intact.
12. `the owner deletes their own evidence and the audit history survives` — delete succeeds, the asset
    row survives as a tombstone (`status = "expired"`), its `evidence_access_events` rows are still
    there, and the listing no longer serves it.
13. `evidence under an active legal hold cannot be deleted` — delete refuses with `FINANCIAL_HOLD`,
    asset stays under `legal_hold` and the hold record is preserved.

---

## 4. What I could not implement (schema gap)

`evidence_assets` has **no tombstone column**: no `deleted_at`, no `deleted_by`, and the
`evidence_state` enum (`pending_upload, verified, quarantined, retained, legal_hold, expired`) has no
`deleted` value. Schema is frozen for this wave, so **no migration was written**.

Safe behaviour implemented with the current schema:

* the asset row is **kept** and parked in `status = "expired"` (`retention_until = now`) — the only
  existing state that means "no longer served";
* `evidence_access_events` and `evidence_legal_holds` rows are **never deleted** any more, so the
  audit trail (who read, who held) survives a deletion and the FKs stay valid;
* the listing and the single-asset read filter the tombstone out;
* the `evidence.deleted` audit event records owner type/id + `sha256` (not the storage key).

**Recommendation for a later wave (needs a migration, out of scope here):** add
`evidence_assets.deleted_at timestamptz` (plus a `deleted` value in `evidence_state`) and switch the
tombstone to that column, so a tombstone is distinguishable from a retention-expired asset.

Second, smaller gap: **no HTTP route exposes `deleteEvidence`** — `src/api/server.ts` imports
`listEvidence` and `registerEvidence` but not `deleteEvidence`. The delete path is therefore
exercised at the service level in the tests; the route owner (the lane currently editing
`src/api/server.ts`) may want to expose `DELETE /evidence/:id`, and `readEvidence` is ready to be
wired as `GET /evidence/:id` the same way.

Third: I did **not** add a privileged "give me the raw storage key" method. Nothing in the current
codebase needs the raw key outside registration; if a download endpoint is added later it must be a
separate, explicitly authorized service method — never a field of the default listing.

---

## 5. `REMEDIATION_PROGRESS.md` discrepancy found (file NOT edited — outside my ownership)

`REMEDIATION_PROGRESS.md` claims P0 finding **LAU-R2-006** is complete:

* "`[x] Implement authorizeEvidenceOwner`" — it existed, but only handled `ownerType === "order"`.
* "`[x] Refactor deleteEvidence to use authorizeEvidenceOwner`" — true, but the check was
  order-only, so claim/custody evidence was unprotected.
* "`[x] Refactor listEvidence to use authorizeEvidenceOwner (Not applicable as it requires asset
  object for check, which is handled at fetching)`" — **false**: `listEvidence` never called
  `authorizeEvidenceOwner`; it re-implemented an order-only check inline and returned `objectKey`
  to the API response.
* "`[x] Verify fix`" — no test covered the claim/custody/partner/cross-tenant cases.

Additionally the file did not mention that `deleteEvidence` deleted `evidence_access_events` and
`evidence_legal_holds` (audit destruction). The file should be corrected by whoever owns it.

---

## 6. Validation actually run

| command | result |
|---|---|
| `npx eslint src/services/workspace.ts test/security/evidence-abac.integration.test.ts` | clean (exit 0) |
| `npm run typecheck` (root + `apps/web`) | exit 0 |
| `npm run lint` (whole repo) | exit 0 — only one pre-existing warning in `test/scenarios/p0.integration.test.ts` (another lane's file); the earlier 4 unused-import errors in `src/api/server.ts` were fixed by that lane meanwhile |
| `npx vitest run test/security/evidence-abac.integration.test.ts` | **13 passed / 13** |
| `npx vitest run` (whole repo) | 303 passed / 1 failed — the single failure is `test/use-cases.integration.test.ts` → "1+2: customer sees the notification feed…" (`expected 1 to be greater than or equal to 2`), a notification-count flake that **passes in isolation** (8/8) and is unrelated to evidence |
| `npx vitest run test/use-cases.integration.test.ts` | 8/8 pass — in particular "8: evidence registration is hash-validated, owner-scoped and access-logged" still passes with the new ownership rule and the key-free listing |

Environment note: the repo's embedded Postgres could not boot (`test/global-setup.ts`) because a
stale postmaster was already holding port 55433; I ran the suite against a local UTF8 embedded
Postgres on that same port with the same database name, so the fixtures and migrations are the
repo's own. No repository file was changed for this.

---

## 7. Concerns

1. **Schema gap** — no tombstone column: `expired` is used as the tombstone marker, which is a
   semantic overload (a retention-expired asset is indistinguishable from a deleted one). A
   `deleted_at` migration is needed in a later wave.
2. **`REMEDIATION_PROGRESS.md` is wrong** about LAU-R2-006 (see section 5) — it must not be trusted
   as evidence that this finding is closed.
3. **`readEvidence` has no route yet** — it is exercised by the tests and ready for the route lane;
   until a route exists, per-id reads happen only through the service.
4. **Dispatcher/staff scope kept as-is** — `dispatcher` still has tenant-wide evidence visibility
   (the pre-existing scope of this file). I did not tighten it, to avoid changing authorization
   outside my task; if the platform wants dispatchers scoped to their own routes, that is a
   separate decision.
5. **Pre-existing full-suite flake** in `test/use-cases.integration.test.ts` (notification count),
   unrelated to this lane but it makes `npm test` red in a full parallel run.
