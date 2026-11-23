import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const schemaPath = resolve(root, "src/db/schema.ts");
const original = readFileSync(schemaPath, "utf8");
const groups = [
  ["01-identity", "0001_identity"],
  ["02-geography", "0002_geography"],
  ["03-catalog", "0003_catalog"],
  ["04-orders", "0004_orders"],
  ["05-scheduling", "0005_scheduling"],
  ["06-items", "0006_items"],
  ["07-evidence", "0007_evidence"],
  ["08-processing", "0008_processing"],
  ["09-routes", "0009_routes"],
  ["10-customer-finance", "0010_customer_finance"],
  ["11-partner-finance", "0011_partner_finance"],
  ["12-support", "0012_support"],
];

if (existsSync(resolve(root, "drizzle"))) {
  rmSync(resolve(root, "drizzle"), { recursive: true, force: true });
}

try {
  for (let index = 0; index < groups.length; index++) {
    const enumExport = 'export * from "./schema/enums.js";\n';
    const exports = enumExport + groups.slice(0, index + 1)
      .map(([file]) => `export * from "./schema/${file}.js";`)
      .join("\n");
    writeFileSync(schemaPath, exports + "\n", "utf8");
    execFileSync(process.execPath, [resolve(root, "node_modules/drizzle-kit/bin.cjs"), "generate", `--name=${groups[index][1]}`], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
  }
} finally {
  writeFileSync(schemaPath, original, "utf8");
}

copyFileSync(
  resolve(root, "scripts/sql/0012_guards.sql"),
  resolve(root, "drizzle/0012_guards.sql"),
);
const journalPath = resolve(root, "drizzle/meta/_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
journal.entries.push({
  idx: journal.entries.length,
  version: "7",
  when: Date.now(),
  tag: "0012_guards",
  breakpoints: true,
});
writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");
console.log("Generated", groups.length, "schema migrations plus append-only guards.");
