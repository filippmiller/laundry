/**
 * The worker's health contract.
 *
 * The worker serves no HTTP endpoint, so its health is "did it complete a recent cycle?". These
 * tests pin that contract down on both halves: the heartbeat the worker writes, and the probe
 * that decides whether the heartbeat is fresh enough. A probe that cannot fail is a defect, so
 * the stale and missing cases matter as much as the healthy one.
 *
 * The tests are pure: no database, no clock, no container.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHeartbeat,
  markCycleFailure,
  readHeartbeat,
  recordCycleFailure,
  recordCycleSuccess,
} from "../../src/workers/index.js";
// @ts-expect-error ESM script helper exports evaluateHeartbeat
import { evaluateHeartbeat } from "../../scripts/worker-health.mjs";

const NOW_MS = Date.parse("2026-11-26T12:00:00.000Z");
const MAX_AGE_MS = 90_000;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/** A throwaway directory for the heartbeat file — never in this repository. */
function heartbeatFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worker-heartbeat-"));
  temporaryDirectories.push(directory);
  return join(directory, ".worker-heartbeat");
}

describe("worker heartbeat health", () => {
  it("treats a fresh successful cycle as healthy", () => {
    const heartbeat = buildHeartbeat({ expired: 2, outboxProcessed: 5 }, new Date(NOW_MS - 5_000));

    const verdict = evaluateHeartbeat({ heartbeat, nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS });

    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("last successful worker cycle");
  });

  it("treats a stale successful cycle as unhealthy and reports the age", () => {
    const heartbeat = buildHeartbeat({ expired: 0 }, new Date(NOW_MS - 120_000));

    const verdict = evaluateHeartbeat({ heartbeat, nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("120s old");
    expect(verdict.reason).toContain("90s limit");
  });

  it("treats a missing heartbeat file as unhealthy", () => {
    const verdict = evaluateHeartbeat({ heartbeat: null, nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no heartbeat");
  });

  it("does not refresh the success timestamp when a cycle fails", () => {
    const succeededAt = new Date(NOW_MS - 120_000);
    const success = buildHeartbeat({ expired: 3 }, succeededAt);

    const failure = markCycleFailure(success, new Error("connection terminated"), new Date(NOW_MS));

    expect(failure.lastSuccessAt).toBe(succeededAt.toISOString());
    expect(failure.lastSuccessSummary).toEqual({ expired: 3 });
    expect(failure.lastFailureAt).toBe(new Date(NOW_MS).toISOString());
    expect(failure.lastFailureMessage).toContain("connection terminated");
  });

  it("keeps the last successful cycle readable after a failed cycle wrote the file", () => {
    const filePath = heartbeatFilePath();
    const succeededAt = new Date(NOW_MS - 120_000);
    recordCycleSuccess({ expired: 3 }, succeededAt, filePath);

    recordCycleFailure(new Error("connection terminated"), new Date(NOW_MS), filePath);

    const heartbeat = readHeartbeat(filePath);
    expect(heartbeat?.lastSuccessAt).toBe(succeededAt.toISOString());
    expect(heartbeat?.lastFailureMessage).toContain("connection terminated");

    // The stale success timestamp is what the probe sees, so the worker still ages out.
    const verdict = evaluateHeartbeat({ heartbeat, nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("120s old");
  });

  it("does not start the worker loop when the module is imported", async () => {
    // Importing the worker module must never begin a cycle: the health tooling and the unit
    // tests load it, and a loop would try to reach the database from inside a test run.
    // The module is re-imported after a registry reset so its body actually runs again.
    vi.resetModules();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      await import("../../src/workers/index.js");
      const delays = setIntervalSpy.mock.calls.map(call => Number(call[1] ?? 0));
      // The worker polls on a multi-second interval; nothing else in the import chain may
      // register one either.
      expect(delays.filter(delay => delay >= 5_000)).toEqual([]);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
