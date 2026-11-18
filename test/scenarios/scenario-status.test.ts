import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The status vocabulary agreed with the master plan. */
const ALLOWED_STATUSES = new Set([
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

/** The statuses that mean "this scenario was actually executed and proved". */
const EXECUTED_STATUSES = new Set([
  "UNIT_PASS",
  "API_PASS",
  "BROWSER_PASS",
  "CROSS_ROLE_PASS",
  "HARDWARE_PASS",
]);

type RegisterScenario = {
  id: string;
  role_area: string;
  priority: string;
  scenario: string;
  required_acceptance: string;
  status: string;
  evidence: string[] | null;
  note: string;
};

type Register = {
  total: number;
  counts: Record<string, number>;
  executed_proofs: Array<{ area: string; proves: string; test: string; command: string; kind: string }>;
  scenarios: RegisterScenario[];
};

type Catalog = {
  scenario_count: number;
  scenarios: Array<{ id: string }>;
  cross_role_flows?: Array<{ id: string; flow: string; roles?: string[]; status?: string }>;
};

const repoRoot = path.resolve(__dirname, "../..");
const catalogPath = path.resolve(
  repoRoot,
  "docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/02_SCENARIO_CATALOG.json",
);
const registerPath = path.resolve(repoRoot, "docs/coverage/PR3_SCENARIO_STATUS.json");

function readCatalog(): Catalog {
  return JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Catalog;
}

function readRegister(): Register {
  return JSON.parse(fs.readFileSync(registerPath, "utf8")) as Register;
}

/** Minimal RFC4180 parser: the CSV contains quoted cells with commas inside them. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; continue; }
        quoted = false;
        continue;
      }
      cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * The scenario register must stay honest.
 *
 * The previous `test/scenarios/p0.integration.test.ts` contained 130 `it()` blocks of which
 * 113 asserted nothing about the system (`expect(true).toBe(true)`), and
 * `test/generated-scenarios.test.ts` merely parsed the catalog JSON. Both inflated the test
 * count without proving a single scenario. They were replaced by this register: one entry per
 * catalog scenario, a truthful status, and a hard rule that an executed status requires
 * evidence that exists in the repository.
 */
describe("PR3 scenario status register", () => {
  it("covers every scenario of the audit catalog exactly once", () => {
    const catalog = readCatalog();
    const register = readRegister();

    expect(register.scenarios.length).toBe(catalog.scenarios.length);
    expect(register.total).toBe(catalog.scenario_count);

    const catalogIds = catalog.scenarios.map(scenario => scenario.id).sort();
    const registerIds = register.scenarios.map(scenario => scenario.id).sort();
    expect(registerIds).toEqual(catalogIds);
    expect(new Set(registerIds).size).toBe(registerIds.length);
  });

  it("never claims an executed status without real evidence on disk", () => {
    const register = readRegister();

    for (const scenario of register.scenarios) {
      if (!EXECUTED_STATUSES.has(scenario.status)) continue;
      expect(scenario.evidence, `${scenario.id} claims ${scenario.status} without evidence`).toBeTruthy();
      for (const pointer of scenario.evidence ?? []) {
        expect(fs.existsSync(path.resolve(repoRoot, pointer)), `${scenario.id} -> ${pointer}`).toBe(true);
      }
    }
  });

  it("only counts statuses that are part of the agreed vocabulary", () => {
    const register = readRegister();

    for (const scenario of register.scenarios) {
      expect(ALLOWED_STATUSES.has(scenario.status), `${scenario.id} -> ${scenario.status}`).toBe(true);
    }
  });

  it("lists the executed proofs with a test file that really exists", () => {
    const register = readRegister();
    expect(register.executed_proofs.length).toBeGreaterThan(0);

    for (const proof of register.executed_proofs) {
      for (const file of proof.test.split(",").map((part: string) => part.trim())) {
        expect(fs.existsSync(path.resolve(repoRoot, file)), file).toBe(true);
      }
    }
  });

  it("keeps the register in sync with the catalog", () => {
    expect(() => {
      execFileSync(process.execPath, ["scripts/generate-scenario-status.mjs", "--check"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    }).not.toThrow();
  });

  it("accounts for every item in the execution CSV and never presents a stale claim as current", () => {
    const catalog = readCatalog();
    const register = readRegister();
    const csvPath = path.resolve(repoRoot, "docs/coverage/PR3_SCENARIO_EXECUTION.csv");
    const lines = parseCsv(fs.readFileSync(csvPath, "utf8")).filter(row => row.some(cell => cell.trim().length));
    const header = lines[0];
    const rows = lines.slice(1);

    // 12 original end-to-end journeys + 36 cross-role flows + 217 catalogue scenarios.
    expect(rows.length).toBe(12 + (catalog.cross_role_flows?.length ?? 0) + register.scenarios.length);

    const column = (row: string[], name: string) => row[header.indexOf(name)] ?? "";
    for (const row of rows) {
      const status = column(row, "status");
      expect(
        ALLOWED_STATUSES.has(status) || status === "NOT_REVERIFIED_CURRENT_HEAD",
        `${column(row, "id")} -> ${status}`,
      ).toBe(true);
      // A previous wave's verdict must sit in its own column, never in `status`.
      if (column(row, "previous_wave_status")) {
        expect(status).not.toBe(column(row, "previous_wave_status"));
      }
    }

    const ids = rows.map(row => column(row, "id"));
    expect(ids.filter(id => id.startsWith("E2E-")).length).toBe(12);
    expect(ids.filter(id => /^F\d\d$/.test(id)).length).toBe(36);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
