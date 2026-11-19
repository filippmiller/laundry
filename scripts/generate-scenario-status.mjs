/**
 * Generate the honest scenario status register from the audit's scenario catalog
 * and the repository's evidence map (`docs/coverage/SCENARIO_EVIDENCE_MAP.json`).
 *
 * The catalog is a *plan*: 217 described scenarios + 36 cross-role flows that have to be
 * executed and evidenced. This script writes one register entry per scenario with a truthful
 * status and NEVER promotes a scenario to a passing state without an evidence pointer that
 * exists on disk.
 *
 *   node scripts/generate-scenario-status.mjs [--check]
 *
 * `--check` verifies that the committed register and execution CSV are in sync with the
 * catalog and evidence map, and that no entry claims an executed status without real evidence
 * on disk. It is used by the test suite, so a fabricated pass cannot be committed unnoticed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = "docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/02_SCENARIO_CATALOG.json";
const EVIDENCE_MAP = "docs/coverage/SCENARIO_EVIDENCE_MAP.json";
const REGISTER = "docs/coverage/PR3_SCENARIO_STATUS.json";
const EXECUTION_CSV = "docs/coverage/PR3_SCENARIO_EXECUTION.csv";
const PREVIOUS_CSV = "docs/coverage/PR3_SCENARIO_EXECUTION.csv";

export const ALLOWED_STATUSES = new Set([
  "SPEC",
  "IMPLEMENTED_UNTESTED",
  "UNIT_PASS",
  "API_PASS",
  "BROWSER_PASS",
  "CROSS_ROLE_PASS",
  "HARDWARE_PASS",
  "BLOCKED",
  "FAIL",
  "N/A",
]);

/** Statuses that mean "this scenario was actually executed and proved". */
export const EXECUTED_STATUSES = new Set([
  "UNIT_PASS",
  "API_PASS",
  "BROWSER_PASS",
  "CROSS_ROLE_PASS",
  "HARDWARE_PASS",
]);

/**
 * The proof artefacts that exist in this repository right now. Each entry names the test
 * file that executes it and what the test actually asserts — no scenario id is promoted
 * on the strength of an adjacent test.
 */
const EXECUTED_PROOFS = [
  {
    area: "Cross-role end-to-end journeys (F01..F35 across all 8 roles)",
    proves: "Real PostgreSQL + Fastify integration tests covering economy/mixed pickup, partner receipt/discrepancy/QC/rewash, adjustments, return-unprocessed, partial delivery, claims with legal hold, compensations, partner accruals/credit notes, concurrent refunds, signed webhooks, admin role/session revocation, last-admin guard, cross-org phone isolation, and guest tracking anti-enumeration.",
    test: "test/scenarios/cross-role-flows.integration.test.ts",
    command: "npx vitest run test/scenarios/cross-role-flows.integration.test.ts",
    kind: "CROSS_ROLE_PASS",
  },
  {
    area: "Adversarial business & security edge cases",
    proves: "Cross-customer container/seal reuse blocked (tenant-scoped uniqueness preserved), friendly-fraud delivery PIN + claim compensation + chargeback race, partner payout Separation of Duties (SoD), broken seal & 50% underweight custody discrepancies, 2x multi-tenant/multi-role negative matrix (AD-020/OP-011), safety_buffer_orders concurrency, optimistic lock race, and idempotency key payload mismatch.",
    test: "test/scenarios/adversarial-business-edge-cases.integration.test.ts",
    command: "npx vitest run test/scenarios/adversarial-business-edge-cases.integration.test.ts",
    kind: "CROSS_ROLE_PASS",
  },
  {
    area: "API contract & frontend route synchronization (OP-013, OP-014)",
    proves: "Every frontend api(...) call in apps/web/src matches a mounted backend route & HTTP method in buildApp(), and OpenAPI 3.1.0 preserves optional query params and security metadata.",
    test: "test/ops/api-contract-sync.test.ts",
    command: "npx vitest run test/ops/api-contract-sync.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Customer ordering journey & mobile/desktop UI",
    proves: "A customer quotes, holds both windows, books an order, gets an invoice and pays with the fake provider; mobile/desktop Russian UI renders cleanly.",
    test: "scripts/smoke-e2e.mjs, scripts/verify-mobile-ui.mjs",
    command: "npm run smoke",
    kind: "BROWSER_PASS",
  },
  {
    area: "Evidence object scope (order / claim / custody_event) and privacy",
    proves: "A customer cannot list or read another customer's claim or custody evidence, a partner cannot read an unassigned order's evidence, another tenant is denied, and the storage key never leaves the service.",
    test: "test/security/evidence-abac.integration.test.ts",
    command: "npx vitest run test/security/evidence-abac.integration.test.ts",
    kind: "API_PASS",
  },
  {
    area: "CSRF / origin enforcement on cookie-authenticated state changes",
    proves: "DELETE, POST and other unsafe methods reject a cross-site Origin, while same-origin and originless clients are allowed.",
    test: "test/security/csrf-unsafe-methods.integration.test.ts",
    command: "npx vitest run test/security/csrf-unsafe-methods.integration.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Money invariants — a voided invoice must never be captured",
    proves: "A cancelled invoice is refused with FINANCIAL_HOLD and creates no payment intent, while an open invoice is captured exactly once.",
    test: "test/api/finance-capture-invoice-state.test.ts",
    command: "npx vitest run test/api/finance-capture-invoice-state.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Finance dashboard contract",
    proves: "GET /finance/overview returns the tenant aggregate, refuses a customer, hides another tenant's rows and refuses an unauthenticated call.",
    test: "test/api/finance-overview.test.ts",
    command: "npx vitest run test/api/finance-overview.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Document rendering and the non-fiscal warning",
    proves: "GET /documents/:kind/:id is object scoped, refuses a forbidden role and carries an explicit 'not a 54-FZ fiscal receipt' disclaimer.",
    test: "test/api/documents.test.ts",
    command: "npx vitest run test/api/documents.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Partner returns an order unprocessed",
    proves: "The order returns unprocessed, the customer is never charged, the held capacity is released, and a partner that is not assigned to the order sees nothing.",
    test: "test/api/partner-return-unprocessed.test.ts",
    command: "npx vitest run test/api/partner-return-unprocessed.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Phone OTP (fake provider) and preview unlock",
    proves: "Only a hash of the code is stored, the surface does not exist in production, attempts are bounded, the preview role allowlist is server side and every attempt is audited.",
    test: "test/api/otp.test.ts, test/api/otp-rate-limit.test.ts, test/api/preview-unlock.test.ts",
    command: "npx vitest run test/api",
    kind: "API_PASS",
  },
  {
    area: "Administrator member suspension",
    proves: "Suspending a member revokes its sessions, another tenant is hidden, the last active administrator cannot be suspended away, and self-suspension is refused.",
    test: "test/api/admin-member-state.test.ts",
    command: "npx vitest run test/api/admin-member-state.test.ts",
    kind: "API_PASS",
  },
  {
    area: "Repository hygiene — no database bytes, secrets, media or oversized blobs tracked",
    proves: "The guard exits non-zero on a planted PostgreSQL cluster, a secret, media and an oversized blob, and prints only paths, never contents.",
    test: "test/ops/guard-repo-hygiene.test.ts",
    command: "npx vitest run test/ops/guard-repo-hygiene.test.ts",
    kind: "UNIT_PASS",
  },
];

function readEvidenceMap() {
  if (!fs.existsSync(EVIDENCE_MAP)) {
    return { scenarios: {}, cross_role_flows: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(EVIDENCE_MAP, "utf8"));
  return {
    scenarios: parsed.scenarios ?? {},
    cross_role_flows: parsed.cross_role_flows ?? {},
  };
}

function validateEvidenceEntry(id, entry) {
  if (!ALLOWED_STATUSES.has(entry.status)) {
    throw new Error(`${EVIDENCE_MAP}: ${id} has unknown status "${entry.status}"`);
  }
  const evidence = entry.evidence ?? null;
  if (EXECUTED_STATUSES.has(entry.status)) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error(`${EVIDENCE_MAP}: ${id} claims ${entry.status} without evidence files`);
    }
    for (const pointer of evidence) {
      if (!fs.existsSync(pointer)) {
        throw new Error(`${EVIDENCE_MAP}: ${id} references missing evidence file "${pointer}"`);
      }
    }
  }
}

/**
 * The 12 original end-to-end journeys (E2E-001..012) were tracked by an earlier wave in
 * `docs/coverage/PR3_SCENARIO_EXECUTION.csv`, with statuses and a commit sha that are now
 * stale. Their previous claim is preserved, but it is never presented as the current
 * status: nothing in this wave re-executed them.
 */
function readPreviousE2eRows() {
  if (!fs.existsSync(PREVIOUS_CSV)) return new Map();
  const lines = fs.readFileSync(PREVIOUS_CSV, "utf8").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return new Map();
  const header = lines[0].split(",");
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const id = cells[0]?.trim();
    if (!id || !id.startsWith("E2E-")) continue;
    const column = name => cells[header.indexOf(name)]?.trim() ?? "";
    rows.set(id, {
      title: column("title"),
      status: column("status"),
      roles: column("role_paths_covered") || column("roles"),
      evidence: column("api_service_evidence") || column("evidence"),
      browser: column("browser_evidence"),
      commit: column("commit") || column("previous_wave_commit"),
      previousStatus: column("previous_wave_status") || column("status"),
      gap: column("remaining_gap"),
    });
  }
  return rows;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildExecutionCsv(catalog, register) {
  const previous = readPreviousE2eRows();
  const rows = [["id", "title", "kind", "status", "roles", "evidence", "browser_evidence", "as_of", "previous_wave_status", "previous_wave_commit", "remaining_gap"]];

  for (const [id, row] of previous) {
    rows.push([
      id,
      row.title,
      "original_e2e",
      // Not re-verified in this wave — the previous claim is kept in its own column.
      "NOT_REVERIFIED_CURRENT_HEAD",
      row.roles,
      row.evidence,
      row.browser,
      register.as_of,
      row.previousStatus,
      row.commit,
      row.gap,
    ]);
  }

  for (const flow of register.cross_role_flows) {
    const evList = flow.evidence ?? [];
    const browserEv = evList.filter(p => p.includes("smoke-e2e") || p.includes("verify-mobile-ui")).join("; ");
    const apiEv = evList.filter(p => !p.includes("smoke-e2e") && !p.includes("verify-mobile-ui")).join("; ");
    rows.push([
      flow.id,
      flow.flow,
      "cross_role_flow",
      flow.status,
      (flow.roles ?? []).join("+"),
      apiEv,
      browserEv,
      register.as_of,
      flow.previous_status ?? "NOT_RUN_CURRENT_HEAD",
      "",
      flow.note,
    ]);
  }

  for (const scenario of register.scenarios) {
    const evList = scenario.evidence ?? [];
    const browserEv = evList.filter(p => p.includes("smoke-e2e") || p.includes("verify-mobile-ui")).join("; ");
    const apiEv = evList.filter(p => !p.includes("smoke-e2e") && !p.includes("verify-mobile-ui")).join("; ");
    rows.push([
      scenario.id,
      scenario.scenario,
      "scenario",
      scenario.status,
      scenario.role_area,
      apiEv,
      browserEv,
      register.as_of,
      "NOT_RUN_CURRENT_HEAD",
      "",
      scenario.note,
    ]);
  }

  return `${rows.map(row => row.map(csvCell).join(",")).join("\n")}\n`;
}

function countByStatus(items) {
  return items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
}

function build() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const evidenceMap = readEvidenceMap();

  const scenarios = catalog.scenarios.map(scenario => {
    const mapped = evidenceMap.scenarios[scenario.id];
    if (mapped) {
      validateEvidenceEntry(scenario.id, mapped);
      return {
        id: scenario.id,
        role_area: scenario.role_area,
        priority: scenario.priority,
        scenario: scenario.scenario,
        required_acceptance: scenario.required_acceptance,
        status: mapped.status,
        evidence: mapped.evidence ?? null,
        note: mapped.note,
      };
    }
    return {
      id: scenario.id,
      role_area: scenario.role_area,
      priority: scenario.priority,
      scenario: scenario.scenario,
      required_acceptance: scenario.required_acceptance,
      status: "SPEC",
      evidence: null,
      note: "Described in the audit catalog; not yet implemented or executed as an automated test.",
    };
  });

  const crossRoleFlows = (catalog.cross_role_flows ?? []).map(flow => {
    const mapped = evidenceMap.cross_role_flows[flow.id];
    if (mapped) {
      validateEvidenceEntry(flow.id, mapped);
      return {
        id: flow.id,
        flow: flow.flow,
        roles: flow.roles ?? [],
        status: mapped.status,
        evidence: mapped.evidence ?? null,
        note: mapped.note,
        previous_status: flow.status ?? "NOT_RUN_CURRENT_HEAD",
      };
    }
    return {
      id: flow.id,
      flow: flow.flow,
      roles: flow.roles ?? [],
      status: "SPEC",
      evidence: null,
      note: "Cross-role journey described in the audit catalog; not yet executed as a named journey test.",
      previous_status: flow.status ?? "NOT_RUN_CURRENT_HEAD",
    };
  });

  return {
    as_of: new Date().toISOString().slice(0, 10),
    source_catalog: CATALOG,
    source_evidence_map: EVIDENCE_MAP,
    catalog_baseline_sha: catalog.baseline_sha,
    total: scenarios.length,
    counts: countByStatus(scenarios),
    cross_role_total: crossRoleFlows.length,
    cross_role_counts: countByStatus(crossRoleFlows),
    executed_proofs: EXECUTED_PROOFS,
    cross_role_flows: crossRoleFlows,
    scenarios,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes("--check");
  const register = build();
  if (check) {
    if (!fs.existsSync(REGISTER)) {
      console.error(`${REGISTER} is missing — run: node scripts/generate-scenario-status.mjs`);
      process.exit(1);
    }
    const committed = JSON.parse(fs.readFileSync(REGISTER, "utf8"));
    const catalogIds = register.scenarios.map(s => s.id).join(",");
    const committedIds = committed.scenarios.map(s => s.id).join(",");
    if (catalogIds !== committedIds) {
      console.error(`${REGISTER} does not cover the catalog — run: node scripts/generate-scenario-status.mjs`);
      process.exit(1);
    }
    for (const scenario of committed.scenarios) {
      if (!ALLOWED_STATUSES.has(scenario.status)) {
        console.error(`${REGISTER}: ${scenario.id} has an unknown status "${scenario.status}"`);
        process.exit(1);
      }
      if (EXECUTED_STATUSES.has(scenario.status)) {
        if (!(scenario.evidence ?? []).length) {
          console.error(`${REGISTER}: ${scenario.id} claims ${scenario.status} without evidence`);
          process.exit(1);
        }
        for (const pointer of scenario.evidence) {
          if (!fs.existsSync(pointer)) {
            console.error(`${REGISTER}: ${scenario.id} references missing evidence "${pointer}"`);
            process.exit(1);
          }
        }
      }
    }
    for (const flow of committed.cross_role_flows ?? []) {
      if (!ALLOWED_STATUSES.has(flow.status)) {
        console.error(`${REGISTER}: ${flow.id} has an unknown status "${flow.status}"`);
        process.exit(1);
      }
      if (EXECUTED_STATUSES.has(flow.status)) {
        if (!(flow.evidence ?? []).length) {
          console.error(`${REGISTER}: ${flow.id} claims ${flow.status} without evidence`);
          process.exit(1);
        }
        for (const pointer of flow.evidence) {
          if (!fs.existsSync(pointer)) {
            console.error(`${REGISTER}: ${flow.id} references missing evidence "${pointer}"`);
            process.exit(1);
          }
        }
      }
    }
    if (JSON.stringify(committed.counts) !== JSON.stringify(register.counts)) {
      console.error(`${REGISTER} counts are out of sync with ${EVIDENCE_MAP} — run: node scripts/generate-scenario-status.mjs`);
      process.exit(1);
    }
    console.log(`${REGISTER}: ${committed.scenarios.length} scenarios, counts ${JSON.stringify(committed.counts)}, cross_role_counts ${JSON.stringify(committed.cross_role_counts ?? {})}`);
    if (!fs.existsSync(EXECUTION_CSV)) {
      console.error(`${EXECUTION_CSV} is missing — run: node scripts/generate-scenario-status.mjs`);
      process.exit(1);
    }
    const csv = fs.readFileSync(EXECUTION_CSV, "utf8");
    const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
    const expectedRows = (catalog.cross_role_flows?.length ?? 0) + committed.scenarios.length + 12;
    const actualRows = csv.split(/\r?\n/).filter(line => line.trim()).length - 1;
    if (actualRows !== expectedRows) {
      console.error(`${EXECUTION_CSV} has ${actualRows} rows, expected ${expectedRows} — run: node scripts/generate-scenario-status.mjs`);
      process.exit(1);
    }
    if (csv.includes(catalog.baseline_sha)) {
      console.log(`${EXECUTION_CSV}: ${actualRows} rows (as_of ${committed.as_of})`);
    }
  } else {
    const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
    fs.mkdirSync(path.dirname(REGISTER), { recursive: true });
    fs.writeFileSync(REGISTER, `${JSON.stringify(register, null, 2)}\n`, "utf8");
    console.log(`wrote ${REGISTER}: ${register.total} scenarios, counts ${JSON.stringify(register.counts)}, cross_role_counts ${JSON.stringify(register.cross_role_counts)}`);
    // The execution CSV is written last so that the previous wave's E2E rows can still be read.
    fs.writeFileSync(EXECUTION_CSV, buildExecutionCsv(catalog, register), "utf8");
    const rows = fs.readFileSync(EXECUTION_CSV, "utf8").split(/\r?\n/).filter(line => line.trim()).length - 1;
    console.log(`wrote ${EXECUTION_CSV}: ${rows} rows`);
  }
}
