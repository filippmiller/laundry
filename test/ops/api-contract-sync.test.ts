import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/api/server.js";
import type { Db } from "../../src/db/client.js";

const repoRoot = path.resolve(__dirname, "../..");
const webSrcDir = path.resolve(repoRoot, "apps/web/src");

type ExtractedCall = {
  file: string;
  line: number;
  method: string;
  rawPath: string;
  normalizedPath: string;
};

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts `api<T>(path, opts?)` calls from frontend TS/TSX source files.
 * Handles single-quoted, double-quoted, and template-literal paths (including multi-line calls).
 */
function extractFrontendApiCalls(): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const files = walkTsFiles(webSrcDir);

  for (const file of files) {
    const relFile = path.relative(repoRoot, file).replace(/\\/g, "/");
    if (relFile === "apps/web/src/api.ts") continue;

    const src = fs.readFileSync(file, "utf8");
    // Match `api(` or `api<...>(`, not `someApi(`
    const callRegex = /(?<![A-Za-z0-9_$.])api\s*(?:<[\s\S]*?>)?\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(src)) !== null) {
      const startIndex = match.index;
      const line = src.slice(0, startIndex).split(/\r?\n/).length;
      const afterOpen = match.index + match[0].length;

      // Skip whitespace/comments to find the first argument
      let i = afterOpen;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      const quote = src[i];
      if (quote !== '"' && quote !== "'" && quote !== "`") {
        continue;
      }

      // Read the string / template literal up to its matching closing quote
      let j = i + 1;
      let rawPath = "";
      let braceDepth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\" && j + 1 < src.length) {
          rawPath += ch + src[j + 1];
          j += 2;
          continue;
        }
        if (quote === "`" && ch === "$" && src[j + 1] === "{") {
          braceDepth += 1;
          rawPath += "${";
          j += 2;
          continue;
        }
        if (braceDepth > 0) {
          if (ch === "{") braceDepth += 1;
          else if (ch === "}") braceDepth -= 1;
          rawPath += ch;
          j += 1;
          continue;
        }
        if (ch === quote) break;
        rawPath += ch;
        j += 1;
      }

      if (!rawPath.startsWith("/")) continue;

      // Look ahead within the same api(...) call for `method: "..."`
      let parenDepth = 1;
      let k = j + 1;
      while (k < src.length && parenDepth > 0) {
        const ch = src[k];
        if (ch === "(") parenDepth += 1;
        else if (ch === ")") parenDepth -= 1;
        k += 1;
      }
      const callRest = src.slice(j + 1, k);
      const methodMatch = callRest.match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i);
      const method = (methodMatch?.[1] ?? "GET").toUpperCase();

      // Replace `${...}` interpolations BEFORE stripping `?query` so a ternary `?` inside `${...}`
      // is not mistaken for a query separator. Expand literal string ternaries into both branches
      // so both target routes are verified against the backend.
      const expandedRawPaths: string[] = [rawPath];
      const ternaryRegex = /\$\{[^}]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\}/;
      while (expandedRawPaths.some(p => ternaryRegex.test(p))) {
        const current = expandedRawPaths.shift()!;
        const m = current.match(ternaryRegex);
        if (m) {
          expandedRawPaths.push(current.replace(ternaryRegex, m[1]));
          expandedRawPaths.push(current.replace(ternaryRegex, m[2]));
        } else {
          expandedRawPaths.push(current);
          break;
        }
      }

      for (const candidate of expandedRawPaths) {
        const replaced = candidate.replace(/\$\{[^}]+\}/g, ":param");
        const normalizedPath = replaced.split("?")[0];
        calls.push({
          file: relFile,
          line,
          method,
          rawPath,
          normalizedPath,
        });
      }
    }
  }

  return calls;
}

/**
 * Matches a normalized frontend path (with `:param` placeholders) against a mounted OpenAPI path
 * (which uses `:id`, `:kind`, `:role`, etc.).
 */
function routeMatches(frontendNormalized: string, backendPath: string): boolean {
  const fSegs = frontendNormalized.split("/").filter(Boolean);
  const bSegs = backendPath.split("/").filter(Boolean);
  if (fSegs.length !== bSegs.length) return false;

  for (let i = 0; i < fSegs.length; i += 1) {
    const f = fSegs[i];
    const b = bSegs[i];
    if (b.startsWith(":")) continue; // Backend route parameter matches any segment
    if (f === ":param") {
      // Dynamic segment in frontend (e.g. `/courier/stops/${id}/${action}` where action is start|arrive)
      // matches literal backend segment when other segments match.
      continue;
    }
    if (f !== b) return false;
  }
  return true;
}

describe("[OP-013][OP-014] API contract & frontend route synchronization", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({} as unknown as Db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("[OP-014] every frontend api(...) call in apps/web/src matches a mounted backend route and HTTP method", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const openapi = res.json() as {
      paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
    };

    const mounted: Array<{ method: string; path: string }> = [];
    for (const [routePath, methods] of Object.entries(openapi.paths)) {
      for (const method of Object.keys(methods)) {
        mounted.push({ method: method.toUpperCase(), path: routePath });
      }
    }
    expect(mounted.length).toBeGreaterThan(50);

    const frontendCalls = extractFrontendApiCalls();
    expect(frontendCalls.length).toBeGreaterThan(40);

    const mismatches: string[] = [];
    for (const call of frontendCalls) {
      const ok = mounted.some(
        route => route.method === call.method && routeMatches(call.normalizedPath, route.path),
      );
      if (!ok) {
        mismatches.push(`${call.file}:${call.line} -> ${call.method} ${call.rawPath} (normalized: ${call.normalizedPath})`);
      }
    }

    expect(mismatches, `Frontend calls missing from backend routes:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("[OP-013] OpenAPI spec generated from actual routes carries methods, responses, security, and optional query params", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            tags?: string[];
            responses?: Record<string, unknown>;
            parameters?: Array<{ name: string; in: string; required: boolean }>;
            security?: unknown[];
          }
        >
      >;
    };

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]?.url).toBe("/api/v1");

    // Verify optional query parameters stay optional (e.g. GET /admin/audit-events?limit=...)
    const auditGet = spec.paths["/admin/audit-events"]?.get;
    expect(auditGet).toBeDefined();
    const limitParam = auditGet?.parameters?.find(p => p.name === "limit" && p.in === "query");
    expect(limitParam).toBeDefined();
    expect(limitParam?.required).toBe(false);

    // Verify public routes have no sessionCookie security, while private routes require it
    expect(spec.paths["/health"]?.get?.security).toBeUndefined();
    expect(spec.paths["/orders"]?.get?.security).toEqual([{ sessionCookie: [] }]);

    // Every operation has summary, tags, and responses
    for (const [routePath, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(op.summary, `${method.toUpperCase()} ${routePath} missing summary`).toBeTruthy();
        expect(op.tags?.length, `${method.toUpperCase()} ${routePath} missing tags`).toBeGreaterThan(0);
        expect(op.responses?.["200"], `${method.toUpperCase()} ${routePath} missing 200 response`).toBeDefined();
      }
    }
  });
});
