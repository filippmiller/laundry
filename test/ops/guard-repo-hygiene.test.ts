/**
 * Proves the repo hygiene guard actually bites.
 *
 * The negative cases are the important half: a guard that cannot fail is a
 * defect, so every violation below is planted in a throwaway git repository in
 * the OS temp directory (never in this repository) and the guard is executed
 * against it as a real child process.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const guardScript = resolve(repoRoot, "scripts", "guard-repo-hygiene.mjs");
const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway git repository — no commits, no remotes, no changes to this repo. */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-guard-"));
  fixtures.push(dir);
  spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir, encoding: "utf8" });
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  spawnSync("git", ["add", "--", "README.md"], { cwd: dir, encoding: "utf8" });
  return dir;
}

/** Stage a file in the fixture repo so the guard sees it as TRACKED. */
function plant(dir: string, relativePath: string, content: string | Buffer) {
  const absolute = join(dir, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
  spawnSync("git", ["add", "--", relativePath], { cwd: dir, encoding: "utf8" });
}

function runGuard(dir: string) {
  const result = spawnSync(process.execPath, [guardScript, "--repo", dir], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("repo hygiene guard", () => {
  it("exits zero on a clean tree", () => {
    const dir = makeFixtureRepo();
    const result = runGuard(dir);
    expect(result.output).toContain("OK");
    expect(result.status).toBe(0);
  });

  it("exits zero on this repository's own tracked files", () => {
    const result = runGuard(repoRoot);
    expect(result.output).toContain("OK");
    expect(result.status).toBe(0);
  });

  it("exits non-zero when a tracked PostgreSQL cluster file is present", () => {
    const dir = makeFixtureRepo();
    plant(dir, ".pgdata-drill/PG_VERSION", "16\n");
    const result = runGuard(dir);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(1);
    expect(result.output).toContain(".pgdata-drill/PG_VERSION");
    expect(result.output).toContain("PostgreSQL data directory");
  });

  it("exits non-zero for a PostgreSQL cluster committed under an unknown directory name", () => {
    const dir = makeFixtureRepo();
    plant(dir, "some-cluster/base/1/24576", "binary-ish\n");
    plant(dir, "some-cluster/PG_VERSION", "16\n");
    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("some-cluster/base/1/24576");
    expect(result.output).toContain("PostgreSQL cluster layout");
    expect(result.output).toContain("some-cluster/PG_VERSION");
    expect(result.output).toContain("PostgreSQL cluster file");
  });

  it("exits non-zero when a tracked secret file is present and never prints its contents", () => {
    const dir = makeFixtureRepo();
    const secret = "SUPER_SECRET_TOKEN=do-not-log-me\n";
    plant(dir, ".env", secret);
    const result = runGuard(dir);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(1);
    expect(result.output).toContain(".env");
    expect(result.output).toContain("environment secret file");
    expect(result.output).not.toContain("do-not-log-me");
    expect(result.output).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("exits non-zero for a tracked media file and for a tracked oversized blob", () => {
    const media = makeFixtureRepo();
    plant(media, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const mediaResult = runGuard(media);
    expect(mediaResult.status).toBe(1);
    expect(mediaResult.output).toContain("assets/logo.png");

    const big = makeFixtureRepo();
    plant(big, "data/dump.bin", Buffer.alloc(3 * 1024 * 1024, 0x41));
    const bigResult = runGuard(big);
    expect(bigResult.status).toBe(1);
    expect(bigResult.output).toContain("data/dump.bin");
    expect(bigResult.output).toContain("oversized tracked file");
  });

  it("allows the tracked example files to pass", () => {
    const dir = makeFixtureRepo();
    plant(dir, ".env.example", "POSTGRES_PASSWORD=change-me\n");
    const result = runGuard(dir);
    expect(result.output).toContain("OK");
    expect(result.status).toBe(0);
  });
});
