#!/usr/bin/env node
/**
 * Live verification of the wave-8 (PR #4) findings against the running stand.
 *
 * The recheck of PR #4 accepted the code of the previous wave but refused three claims that only
 * a running server can settle: that an open escalation stays closable while its order moves on,
 * that the server really refuses the escalation actions of a finance-only operator, and that the
 * privacy export states what it covers instead of quietly truncating the caller's own history.
 *
 * Every check prints one line:
 *   CHECK <id> <NAME>: PASS|SKIP|FAIL — <detail>
 * and the script exits non-zero when a check that ran failed. A check that could not run is
 * SKIPPED with the reason — never passed.
 *
 * Usage (the stand must be running and seeded):
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/verify-wave8.mjs
 *
 * The report lands in docs/evidence/wave8/ as a JSON file and a Markdown summary.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/evidence/wave8");

const PERSONAS = {
  customer: "+79990000001",
  courier: "+79990000002",
  dispatcher: "+79990000003",
  laundry_operator: "+79990000004",
  platform_finance: "+79990000005",
  claims_approver: "+79990000006",
  customer_support: "+79990000007",
  platform_admin: "+79990000008",
  partner_finance: "+79990000009",
  laundry_supervisor: "+79990000010",
};

const results = [];

function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`CHECK ${id} ${name}: ${status} — ${detail}`);
}
function pass(id, name, detail) {
  record(id, name, "PASS", detail);
}
function skip(id, name, detail) {
  record(id, name, "SKIP", detail);
}
function fail(id, name, detail) {
  record(id, name, "FAIL", detail);
}

async function resolveOrganization() {
  if (process.env.DEMO_ORG) return process.env.DEMO_ORG;
  const res = await fetch(`${BASE}/api/v1/dev/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  const payload = await res.json();
  const org = payload.organizationId ?? payload.demoBook?.organizationId ?? null;
  if (!org) throw new Error("the seed response carries no organizationId");
  return org;
}

let ORG = null;

async function login(role, phone) {
  if (!ORG) ORG = await resolveOrganization();
  // The API rate-limits the login endpoint: a short pause between logins keeps the run stable.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${BASE}/api/v1/auth/demo-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: ORG, phone, roles: [role] }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = /laundry_session=([^;]+)/.exec(setCookie);
    if (match) return `laundry_session=${match[1]}`;
    if (res.status === 429) {
      await new Promise(done => setTimeout(done, 3000));
      continue;
    }
    throw new Error(`login failed for ${role}: ${res.status} ${await res.text()}`);
  }
  throw new Error(`login failed for ${role}: rate limited`);
}

async function call(cookie, path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {
    cookie,
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  // Every mutation in this API is idempotency-keyed.
  if (method !== "GET") headers["idempotency-key"] = `verify-wave8-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...options,
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: res.status, payload, headers: res.headers };
}

/** The identity of the code that is on disk right now. */
function codeIdentity() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain"]) ?? "";
  const changed = status.split(/\r?\n/).filter(Boolean);
  const diff = git(["diff", "HEAD"]) ?? "";
  return {
    codeSha: git(["rev-parse", "HEAD"]),
    codeTree: git(["rev-parse", "HEAD^{tree}"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: changed.length > 0,
    changedFiles: changed.map(line => line.slice(0, 2).trim() + " " + line.slice(3).trim()),
    diffSha256: createHash("sha256").update(diff, "utf8").digest("hex"),
  };
}

/** Every key of the payload that looks like an internal credential. */
function credentialLikeKeys(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) credentialLikeKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/token|hash|secret|password|credential/i.test(key)) found.push(key);
      credentialLikeKeys(item, found);
    }
  }
  return found;
}

async function main() {
  const startedAt = new Date();
  const code = codeIdentity();
  ORG = await resolveOrganization();

  const dispatcher = await login("dispatcher", PERSONAS.dispatcher);
  const finance = await login("platform_finance", PERSONAS.platform_finance);

  // --- LND-R5-06: an open escalation stays reachable while its order moves on -----------------
  const orders = await call(dispatcher, "/orders");
  const orderItems = Array.isArray(orders.payload?.items)
    ? orders.payload.items
    : Array.isArray(orders.payload)
      ? orders.payload
      : [];
  // The order of the fixture must NOT be one of the idle ones: the check proves that the queues
  // are apart, and an order that is idle anyway would prove nothing.
  const idleBefore = await call(dispatcher, "/ops/stuck-orders?minutes=30");
  const idleOrderIds = new Set(
    (Array.isArray(idleBefore.payload?.items) ? idleBefore.payload.items : []).map(item => item.orderId),
  );
  const order = orderItems.find(item => !idleOrderIds.has(item.id)) ?? null;

  if (!order) {
    skip(
      "LND-R5-06-1",
      "an open escalation stays reachable while its order moves on",
      `the demo book holds no order outside the idle queue (${orderItems.length} order(s), all of them idle) — the two queues cannot be told apart with this stand`,
    );
    skip("LND-R5-06-2", "an escalation is closed explicitly with a reason", "no order to escalate");
    skip("LND-R5-06-3", "the escalation names a responsible person", "no order to escalate");
  } else {
    const reason = `Волна 8: проверка очереди открытых эскалаций ${new Date().toISOString()}`;
    const escalated = await call(dispatcher, `/orders/${order.id}/escalations`, {
      method: "POST",
      body: { reason },
    });
    const escalationId = escalated.payload?.escalationId ?? null;

    if (escalated.status !== 200 || !escalationId) {
      fail(
        "LND-R5-06-1",
        "an open escalation stays reachable while its order moves on",
        `POST /orders/:id/escalations returned ${escalated.status}: ${JSON.stringify(escalated.payload).slice(0, 300)}`,
      );
      skip("LND-R5-06-2", "an escalation is closed explicitly with a reason", "the escalation was not opened");
      skip("LND-R5-06-3", "the escalation names a responsible person", "the escalation was not opened");
    } else {
      // The order was just created, so it is NOT idle — it cannot appear in the queue of stuck
      // orders. The escalation still has to be there, otherwise there is no way to close it.
      const queue = await call(dispatcher, "/ops/stuck-orders?minutes=30");
      const escalationRows = Array.isArray(queue.payload?.escalations)
        ? queue.payload.escalations
        : [];
      const row = escalationRows.find(item => item.id === escalationId) ?? null;
      const idleRows = Array.isArray(queue.payload?.items) ? queue.payload.items : [];
      const orderIsIdle = idleRows.some(item => item.orderId === order.id);

      if (!row) {
        fail(
          "LND-R5-06-1",
          "an open escalation stays reachable while its order moves on",
          `the escalation ${String(escalationId).slice(0, 8)} is open, but the queue of open escalations holds ${escalationRows.length} row(s) — there is no way to close it`,
        );
      } else if (orderIsIdle) {
        fail(
          "LND-R5-06-1",
          "an open escalation stays reachable while its order moves on",
          "the order still shows up in the idle queue, so the check cannot tell the two queues apart",
        );
      } else {
        pass(
          "LND-R5-06-1",
          "an open escalation stays reachable while its order moves on",
          `the order ${String(order.id).slice(0, 8)} is NOT in the idle queue (it was just created), but its open escalation is listed in the queue of open escalations with the reason "${row.reason}"`,
        );
      }

      // The responsible person must be named, not left empty.
      const named = typeof row?.assigneeName === "string" && row.assigneeName.trim().length > 0;
      const authorNamed = typeof row?.escalatedByName === "string" && row.escalatedByName.trim().length > 0;
      if (named) {
        pass(
          "LND-R5-06-3",
          "the escalation names a responsible person",
          `the escalation names "${row.assigneeName}"${authorNamed ? ` (the author is "${row.escalatedByName}")` : ""}`,
        );
      } else if (authorNamed) {
        pass(
          "LND-R5-06-3",
          "the escalation names a responsible person",
          `no assignee is named, but the author "${row.escalatedByName}" is — the responsible person is the author by policy and the panel says so`,
        );
      } else {
        fail(
          "LND-R5-06-3",
          "the escalation names a responsible person",
          `the escalation carries neither an assignee (${JSON.stringify(row?.assigneeName)}) nor an author (${JSON.stringify(row?.escalatedByName)})`,
        );
      }

      // --- LND-R5-07: the server refuses the escalation actions of a finance-only operator -----
      const financeEscalate = await call(finance, `/orders/${order.id}/escalations`, {
        method: "POST",
        body: { reason: "Волна 8: финансист не должен иметь права открывать эскалацию." },
      });
      if (financeEscalate.status === 403) {
        pass(
          "LND-R5-07-1",
          "a finance-only operator cannot open an escalation",
          `the server answered ${financeEscalate.status} — the rights of the backend were not widened`,
        );
      } else {
        fail(
          "LND-R5-07-1",
          "a finance-only operator cannot open an escalation",
          `the server answered ${financeEscalate.status}: ${JSON.stringify(financeEscalate.payload).slice(0, 200)}`,
        );
      }

      const financeResolve = await call(finance, `/escalations/${escalationId}/resolve`, {
        method: "POST",
        body: { resolution: "Волна 8: финансист не должен иметь права закрывать эскалацию." },
      });
      if (financeResolve.status === 403) {
        pass(
          "LND-R5-07-2",
          "a finance-only operator cannot close an escalation",
          `the server answered ${financeResolve.status} — the rights of the backend were not widened`,
        );
      } else {
        fail(
          "LND-R5-07-2",
          "a finance-only operator cannot close an escalation",
          `the server answered ${financeResolve.status}: ${JSON.stringify(financeResolve.payload).slice(0, 200)}`,
        );
      }

      // The dispatcher closes the escalation explicitly, with a reason.
      const resolution = "Волна 8: эскалация закрыта после проверки очереди.";
      const resolved = await call(dispatcher, `/escalations/${escalationId}/resolve`, {
        method: "POST",
        body: { resolution },
      });
      const queueAfter = await call(dispatcher, "/ops/stuck-orders?minutes=30");
      const stillOpen = (queueAfter.payload?.escalations ?? []).some(item => item.id === escalationId);
      if (resolved.status === 200 && !stillOpen) {
        pass(
          "LND-R5-06-2",
          "an escalation is closed explicitly with a reason",
          `the dispatcher closed the escalation with "${resolution}" (status ${resolved.status}); it left the queue of open escalations`,
        );
      } else {
        fail(
          "LND-R5-06-2",
          "an escalation is closed explicitly with a reason",
          `resolve status=${resolved.status} body=${JSON.stringify(resolved.payload).slice(0, 200)} stillOpen=${stillOpen}`,
        );
      }
    }
  }

  // --- LND-R5-05: the export states its coverage and does not truncate ------------------------
  const exported = await call(finance, "/me/privacy-export");
  const sessions = exported.payload?.sessions;
  if (exported.status !== 200 || !sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    fail(
      "LND-R5-05-1",
      "the privacy export states the coverage of its sessions section",
      `status=${exported.status} the sessions section is ${JSON.stringify(sessions)?.slice(0, 200)}`,
    );
    skip("LND-R5-05-2", "the export carries no internal credential", "the export did not answer");
  } else {
    const coverage = sessions.coverage ?? {};
    const states = Array.isArray(coverage.states) ? coverage.states : [];
    const counts = {
      active: sessions.active,
      expired: sessions.expired,
      revoked: sessions.revoked,
    };
    const total = sessions.total;
    const items = Array.isArray(sessions.items) ? sessions.items : [];
    const sum = counts.active + counts.expired + counts.revoked;
    const complete = exported.payload?.exportMeta?.complete;
    const coverageStated = coverage.policy === "all_own_sessions"
      && ["active", "expired", "revoked"].every(state => states.includes(state));
    if (!coverageStated) {
      fail(
        "LND-R5-05-1",
        "the privacy export states the coverage of its sessions section",
        `the coverage registry reads ${JSON.stringify(coverage)} — the states are not stated`,
      );
    } else if (sum !== total || items.length !== total) {
      fail(
        "LND-R5-05-1",
        "the privacy export states the coverage of its sessions section",
        `total=${total} but active+expired+revoked=${sum} and items=${items.length} — the counts do not add up`,
      );
    } else if (complete !== true) {
      fail(
        "LND-R5-05-1",
        "the privacy export states the coverage of its sessions section",
        `the export claims complete=${complete} — the flag must be truthful`,
      );
    } else {
      pass(
        "LND-R5-05-1",
        "the privacy export states the coverage of its sessions section",
        `policy=${coverage.policy}, states=[${states.join(", ")}], total=${total} (active ${counts.active}, expired ${counts.expired}, revoked ${counts.revoked}), items=${items.length}, complete=${complete}`,
      );
    }

    const leaked = credentialLikeKeys(exported.payload);
    if (leaked.length === 0) {
      pass(
        "LND-R5-05-2",
        "the export carries no internal credential",
        `no key of the payload looks like a token, a hash, a secret or a password; the session rows carry ${Object.keys(items[0] ?? {}).join(", ") || "no field"}`,
      );
    } else {
      fail(
        "LND-R5-05-2",
        "the export carries no internal credential",
        `the payload carries ${leaked.join(", ")}`,
      );
    }
  }

  // --- the report ----------------------------------------------------------------------------
  const failed = results.filter(result => result.status === "FAIL");
  const skipped = results.filter(result => result.status === "SKIP");
  const passed = results.filter(result => result.status === "PASS");
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: startedAt.toISOString(),
    baseUrl: BASE,
    organizationId: ORG,
    code: {
      ...code,
      evidenceCommit: null,
      evidenceCommitNote: "the commit that carries this receipt is named in the remediation report; a document cannot state its own SHA",
    },
    summary: {
      total: results.length,
      passed: passed.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    checks: results,
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const jsonPath = resolve(EVIDENCE_DIR, `verify-wave8-${stamp}.json`);
  const mdPath = resolve(EVIDENCE_DIR, `verify-wave8-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mdRows = results
    .map(result => `| ${result.id} | ${result.name} | ${result.status} | ${String(result.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const markdown = [
    `# Wave 8 live verification (PR #4)`,
    ``,
    `- Stand: \`${BASE}\``,
    `- Code: \`${code.codeSha}\` tree \`${code.codeTree}\` on \`${code.branch}\``,
    `- Working tree: ${code.dirty ? `DIRTY — ${code.changedFiles.length} path(s)` : "clean"}`,
    `- Diff digest (sha256 of \`git diff HEAD\`): \`${code.diffSha256}\``,
    `- Organization: \`${ORG}\``,
    `- Started at: \`${report.generatedAt}\``,
    `- Result: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (${results.length} checks)`,
    ``,
    `| Check | Name | Result | Detail |`,
    `| --- | --- | --- | --- |`,
    mdRows,
    ``,
    `The commit that carries this receipt is named in the remediation report: a document cannot`,
    `state its own SHA.`,
    ``,
  ].join("\n");
  writeFileSync(mdPath, markdown, "utf8");

  console.log(`\n${passed.length}/${results.length} checks passed (${skipped.length} skipped, ${failed.length} failed)`);
  console.log(`report: ${jsonPath}`);
  console.log(`summary: ${mdPath}`);
  if (failed.length) {
    console.log("FAILED:");
    for (const item of failed) console.log(` - ${item.id} ${item.name} (${item.detail})`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("verification crashed:", err);
  process.exitCode = 1;
});
