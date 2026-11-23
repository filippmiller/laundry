#!/usr/bin/env node
/**
 * Repo hygiene guard.
 *
 * Fails (non-zero exit) when the repository TRACKS forbidden content:
 * PostgreSQL cluster bytes, secrets, media/archives or oversized blobs.
 *
 * Rules of the road:
 *   - Only TRACKED files are inspected (`git ls-files`), because the guard is
 *     about what is committed, not what happens to sit on a developer disk.
 *   - File CONTENTS are never read and never printed. The report lists paths
 *     and reasons only, so secrets cannot leak into CI logs.
 *   - Blob sizes come from git plumbing (`git ls-files -s` +
 *     `git cat-file --batch-check`), so no file is ever loaded into memory.
 *   - Pure Node, no dependencies beyond `node:child_process`.
 *
 * Usage:
 *   node scripts/guard-repo-hygiene.mjs [--repo <path>]
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = the guard could not run.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Any tracked blob larger than this is reported as an oversized binary. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Local PostgreSQL data directories produced by this project's own scripts.
 * Sources: scripts/dev-db.mjs (.pgdata), test/global-setup.ts (.pgdata-test),
 * scripts/upgrade-restore-drill.ts (.pgdata-drill).
 */
const PG_DATA_DIRS = [".pgdata", ".pgdata-test", ".pgdata-drill"];

/** Directory names that only exist inside a PostgreSQL data directory. */
const PG_CLUSTER_DIRS = new Set([
  "pg_wal", "pg_wal/archive_status", "pg_xact", "pg_stat", "pg_stat_tmp",
  "pg_subtrans", "pg_multixact", "pg_multixact/members", "pg_multixact/offsets",
  "pg_twophase", "pg_commit_ts", "pg_logical", "pg_logical/snapshots",
  "pg_logical/mappings", "pg_notify", "pg_serial", "pg_snapshots", "pg_dynshmem",
  "pg_replslot", "pg_tblspc", "pg_dynshmem", "pg_stat/pgstat.stat",
]);

/** File names that only exist inside a PostgreSQL data directory. */
const PG_CLUSTER_FILES = new Set([
  "PG_VERSION", "postgresql.conf", "postgresql.auto.conf", "postmaster.pid",
  "postmaster.opts", "pg_control", "pg_ident.conf", "pg_hba.conf",
  "pg_filenode.map", "backup_label", "tablespace_map",
]);

/** Extensions that carry secret key material. */
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".truststore"]);

/** Extensions that carry media or archive payloads. */
const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
]);

/** Exact file names that carry secrets. */
const SECRET_FILE_NAMES = new Set(["credentials.json", ".npmrc", ".pypirc"]);

function parseArgs(argv) {
  let repo = process.env.GUARD_REPO_ROOT ?? process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" && argv[i + 1]) {
      repo = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/guard-repo-hygiene.mjs [--repo <path>]");
      process.exit(0);
    }
  }
  return resolve(repo);
}

function git(args, cwd, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

/** Tracked entries: path, mode and blob id, straight from the index. */
function listTrackedEntries(repo) {
  const raw = git(["ls-files", "-s", "-z"], repo);
  const entries = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (!path) continue;
    entries.push({ path, mode, sha });
  }
  return entries;
}

/**
 * Real blob sizes straight from the object database — file contents are never
 * read. Missing objects (shallow/partial clones) are reported as unknown.
 */
function blobSizes(repo, shas) {
  const unique = [...new Set(shas.filter(Boolean))];
  const sizes = new Map();
  if (unique.length === 0) return sizes;
  const raw = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd: repo,
    input: `${unique.join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  const lines = raw.split("\n");
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const [sha, type, size] = parts;
    if (type === "blob" && Number.isFinite(Number(size))) sizes.set(sha, Number(size));
  }
  return sizes;
}

function isExampleFile(path) {
  const base = path.split("/").pop() ?? path;
  return /\.example(\.[^/]+)?$/i.test(base);
}

function postgresReason(path) {
  const segments = path.split("/");
  const base = segments[segments.length - 1];

  for (const dir of PG_DATA_DIRS) {
    if (segments.includes(dir)) return `inside the local PostgreSQL data directory "${dir}"`;
  }
  for (const segment of segments) {
    if (PG_CLUSTER_DIRS.has(segment)) return `PostgreSQL cluster directory "${segment}"`;
  }
  for (let i = 0; i < segments.length - 1; i += 1) {
    const parent = segments[i];
    const child = segments[i + 1];
    if ((parent === "base" || parent === "global") && /^\d+$/.test(child)) {
      return `PostgreSQL cluster layout "${parent}/${child}"`;
    }
    if (parent === "global" && child.startsWith("pg_")) {
      return `PostgreSQL cluster layout "global/${child}"`;
    }
  }
  if (PG_CLUSTER_FILES.has(base)) return `PostgreSQL cluster file "${base}"`;
  return null;
}

function secretReason(path) {
  const base = path.split("/").pop() ?? path;
  if (isExampleFile(path)) return null; // .env.example and friends are intended to be tracked
  if (base === ".env" || base.startsWith(".env.")) return "environment secret file";
  if (SECRET_FILE_NAMES.has(base)) return "credentials file";
  if (/^secrets?\./i.test(base)) return "secrets file";
  if (/^id_rsa/i.test(base) && !base.endsWith(".pub")) return "private key material";
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
  if (SECRET_EXTENSIONS.has(extension)) return `secret key material (${extension})`;
  return null;
}

function mediaReason(path) {
  const base = path.split("/").pop() ?? path;
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
  if (MEDIA_EXTENSIONS.has(extension)) return `media or archive file (${extension})`;
  return null;
}

export function collectViolations(repo) {
  const entries = listTrackedEntries(repo);
  const sizes = blobSizes(repo, entries.map((entry) => entry.sha));
  const violations = [];

  for (const entry of entries) {
    if (entry.mode === "160000") continue; // gitlink (submodule), not a file in this tree
    const reasons = [];
    const postgres = postgresReason(entry.path);
    if (postgres) reasons.push(postgres);
    const secret = secretReason(entry.path);
    if (secret) reasons.push(secret);
    const media = mediaReason(entry.path);
    if (media) reasons.push(media);
    const size = sizes.get(entry.sha);
    if (size !== undefined && size > MAX_BLOB_BYTES) {
      reasons.push(`oversized tracked file (${size} bytes > ${MAX_BLOB_BYTES} bytes)`);
    }
    if (reasons.length > 0) violations.push({ path: entry.path, reasons });
  }

  return { checked: entries.length, violations };
}

function main() {
  const repo = parseArgs(process.argv.slice(2));

  let insideRepo = false;
  try {
    insideRepo = git(["rev-parse", "--is-inside-work-tree"], repo).trim() === "true";
  } catch {
    insideRepo = false;
  }
  if (!insideRepo) {
    console.error(`guard-repo-hygiene: "${repo}" is not a git working tree; cannot inspect tracked files.`);
    process.exit(2);
  }

  let report;
  try {
    report = collectViolations(repo);
  } catch (error) {
    console.error(`guard-repo-hygiene: failed to inspect tracked files: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (report.violations.length === 0) {
    console.log(`guard-repo-hygiene: OK — ${report.checked} tracked file(s) inspected, no violations.`);
    process.exit(0);
  }

  console.error(`guard-repo-hygiene: ${report.violations.length} violation(s) in tracked files:`);
  console.error("");
  for (const violation of report.violations) {
    console.error(`  ${violation.path}`);
    for (const reason of violation.reasons) {
      console.error(`      -> ${reason}`);
    }
  }
  console.error("");
  console.error("guard-repo-hygiene: remove these paths from the index (or ignore them) before committing.");
  console.error("guard-repo-hygiene: only paths and reasons are printed — contents are never read or shown.");
  process.exit(1);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
