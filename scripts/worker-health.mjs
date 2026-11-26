#!/usr/bin/env node
/**
 * Worker health probe.
 *
 * The worker serves no HTTP endpoint, so its health cannot be a port probe: the container is
 * "up" long before it has done any work. The honest signal is the heartbeat file that the
 * worker writes after every successful cycle — this script reads it and decides whether the
 * last successful cycle is recent enough.
 *
 * The staleness limit is three worker intervals by default (WORKER_INTERVAL_MS), so a worker
 * that is alive but no longer cycling is reported unhealthy instead of looking idle-but-fine.
 * WORKER_HEARTBEAT_MAX_AGE_MS overrides the limit outright.
 *
 * Usage:
 *   node scripts/worker-health.mjs
 *
 * Exit codes: 0 = healthy, 1 = unhealthy (no reason to retry the same second).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the heartbeat lives when WORKER_HEARTBEAT_FILE is not set. */
export const DEFAULT_HEARTBEAT_FILE = "./.worker-heartbeat";

/** The worker's own default cycle interval, used when WORKER_INTERVAL_MS is not set. */
export const DEFAULT_WORKER_INTERVAL_MS = 30_000;

/** How many intervals a worker may miss before it is considered stuck. */
export const MAX_AGE_INTERVALS = 3;

/**
 * The heartbeat file to read.
 *
 * Absolute paths are used as given; a relative path is resolved against the working directory
 * so the probe and the worker agree even when they are started from different directories.
 */
export function heartbeatFilePath(env = process.env) {
  const configured = env.WORKER_HEARTBEAT_FILE?.trim();
  return configured ? resolve(configured) : resolve(DEFAULT_HEARTBEAT_FILE);
}

/**
 * How old the last successful cycle may be.
 *
 * WORKER_HEARTBEAT_MAX_AGE_MS wins; otherwise three worker intervals, which tolerates one
 * missed cycle plus the slack of a slow one.
 */
export function resolveMaxAgeMs(env = process.env) {
  const explicit = Number(env.WORKER_HEARTBEAT_MAX_AGE_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const interval = Number(env.WORKER_INTERVAL_MS);
  const effectiveInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_WORKER_INTERVAL_MS;
  return effectiveInterval * MAX_AGE_INTERVALS;
}

/**
 * Decides whether a heartbeat proves the worker is alive and cycling.
 *
 * Pure: it takes the parsed heartbeat (or null when there is none), the current time and the
 * age limit, so the unit test can exercise every case without a clock or a filesystem.
 */
export function evaluateHeartbeat({ heartbeat, nowMs, maxAgeMs }) {
  const limit = Math.max(0, Number(maxAgeMs) || 0);

  if (!heartbeat || typeof heartbeat !== "object") {
    return {
      ok: false,
      reason: "no heartbeat: the worker has not completed a cycle yet (heartbeat file missing or unreadable)",
    };
  }

  const lastSuccessAt = typeof heartbeat.lastSuccessAt === "string" ? heartbeat.lastSuccessAt : null;
  if (!lastSuccessAt) {
    const failure = heartbeat.lastFailureMessage ? `; last failure: ${heartbeat.lastFailureMessage}` : "";
    return {
      ok: false,
      reason: `no heartbeat: the worker has never completed a successful cycle${failure}`,
    };
  }

  const lastSuccessMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) {
    return { ok: false, reason: `unreadable heartbeat: "${lastSuccessAt}" is not a valid timestamp` };
  }

  const ageMs = nowMs - lastSuccessMs;
  const ageSeconds = Math.round(ageMs / 1000);
  const limitSeconds = Math.round(limit / 1000);

  if (ageMs > limit) {
    return {
      ok: false,
      reason: `stale heartbeat: the last successful worker cycle is ${ageSeconds}s old, older than the ${limitSeconds}s limit`,
    };
  }

  return {
    ok: true,
    reason: `heartbeat ok: the last successful worker cycle is ${ageSeconds}s old (limit ${limitSeconds}s)`,
  };
}

/** Reads and parses the heartbeat file. Returns null when it is missing or malformed. */
export function readHeartbeatFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function main() {
  const filePath = heartbeatFilePath();
  const maxAgeMs = resolveMaxAgeMs();
  const heartbeat = readHeartbeatFile(filePath);
  const verdict = evaluateHeartbeat({ heartbeat, nowMs: Date.now(), maxAgeMs });

  if (verdict.ok) {
    console.log(`worker-health: ${verdict.reason}`);
    process.exit(0);
  }

  console.error(`worker-health: ${verdict.reason} (heartbeat file: ${filePath})`);
  process.exit(1);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
