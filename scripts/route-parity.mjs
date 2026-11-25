/**
 * Route/UI parity scan: every API route declared in src/api/server.ts against
 * every path the web app calls. The audit used this to find endpoints that no
 * screen reaches (LA-16, TRIA-001..TRIA-007).
 *
 * Usage (from the repository root):
 *   node scripts/route-parity.mjs
 *
 * The remaining routes without a UI caller are expected to be infrastructure:
 * /health, /health/ready, /openapi.json, the provider webhooks and the
 * single-hold slot route (the UI books pickup+delivery pairs by design —
 * see TRIA-008).
 */
import { readFileSync, globSync } from "node:fs";

const serverSrc = readFileSync("src/api/server.ts", "utf8");
const routes = [...serverSrc.matchAll(/path:\s*"([^"]+)"/g)].map(m => m[1]);

const files = [];
for (const e of globSync("apps/web/src/**/*")) if (/\.tsx?$/.test(e)) files.push(e);
const webSrc = files.map(f => readFileSync(f, "utf8")).join("\n");

/**
 * Normalises a literal or template path to the shape the route registry uses:
 * `${...}` becomes `:param`, the query string is dropped and the `/api/v1`
 * prefix is removed.
 */
function normalise(raw) {
  let p = raw.trim();
  // Collapse the template placeholders BEFORE stripping the query string: a
  // placeholder may contain a "?" (a ternary inside ${...}).
  p = p.replace(/\$\{[^}]*\}/g, ":param");
  p = p.split("?")[0];
  p = p.replace(/^\/?api\/v1\//, "");
  p = p.replace(/^\//, "").replace(/\/$/, "");
  return p;
}

const calls = new Set();

// 1. api<T>("path") / api(`path`) — the typed client of the web app.
for (const m of webSrc.matchAll(/\bapi(?:<[\s\S]*?>)?\(\s*([`"'])([\s\S]*?)\1/g)) {
  calls.add(normalise(m[2]));
}

// 2. fetch("/api/v1/path") — the raw calls that bypass the client.
for (const m of webSrc.matchAll(/\bfetch\(\s*([`"'])([\s\S]*?)\1/g)) {
  calls.add(normalise(m[2]));
}

// 3. request("/path") — the injected transport of the auth/logout helper.
for (const m of webSrc.matchAll(/\brequest\(\s*([`"'])([\s\S]*?)\1/g)) {
  calls.add(normalise(m[2]));
}

/**
 * Endpoints that the static scan cannot connect to a call site, with the
 * reason. They are listed separately instead of being hidden, so that a
 * reviewer can judge each one.
 */
const INDIRECT = new Map([
  // The web client itself prefixes every request with /api/v1 — a dynamic
  // path, not an endpoint.
  ["api/v1:param", "dynamic prefix of the web client (apps/web/src/api.ts)"],
  // AdminWorkspace.runOpsAction(key, path, text) passes the path as a
  // variable, so the literal does not appear inside an api() call.
  ["/ops/outbox/drain", "AdminWorkspace.runOpsAction — the path is a variable"],
  ["/ops/expire-holds", "AdminWorkspace.runOpsAction — the path is a variable"],
  // The UI books a pickup+delivery pair in one request; the single-hold route
  // stays internal on purpose (TRIA-008).
  ["/slots/holds", "single hold — by design, the UI books pairs (TRIA-008)"],
]);

const segMatch = (call, route) => {
  const cs = call.split("/").filter(Boolean);
  const rs = route.replace(/^\//, "").split("/").filter(Boolean);
  if (cs.length !== rs.length) return false;
  return rs.every((seg, i) => seg.startsWith(":") || seg === cs[i] || cs[i] === ":param");
};

console.log("ROUTES:", routes.length, "| CALL PATHS:", calls.size);

const orphans = routes.filter(r => ![...calls].some(c => segMatch(c, r)));

console.log("\n=== ROUTES WITH NO UI CALLER (verified by static scan) ===");
for (const r of orphans) {
  const note = INDIRECT.get(r);
  console.log(`   ${r}${note ? `   — ${note}` : ""}`);
}

console.log("\n=== WEB CALL PATHS WITH NO MATCHING ROUTE ===");
for (const c of [...calls].sort()) {
  if (routes.some(r => segMatch(c, r))) continue;
  const note = INDIRECT.get(c);
  console.log(`   ${c}${note ? `   — ${note}` : ""}`);
}
