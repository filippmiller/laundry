# Lane C report — Repo hygiene: broken ignore rule repaired + CI guard added

**Lane:** C (Ops / repo hygiene) — **Status:** DONE_WITH_CONCERNS
**Scope owned:** `.gitignore`, `.github/**`, `scripts/guard-repo-hygiene.mjs` (new), `test/ops/**` (new),
`package.json` (new script entry only), `.githooks/pre-commit` (new, **not installed**).
**Not touched:** `apps/web/**`, `src/**`, `scripts/upgrade-restore-drill.ts`, `scripts/dev-db.mjs`,
`test/global-setup.ts`, `eslint.config.mjs`, any VCS state (no `add`/`commit`/`rm --cached`/`push`,
no remote added, no `core.hooksPath` written).

---

## 1. `.gitignore` — before / after

### Before (184 bytes, mixed UTF-8 + one UTF-16LE line + trailing NUL garbage)

```
node_modules/
dist/
coverage/
!docs/coverage/
!docs/coverage/**
.env
.env.*
!.env.example
.pgdata/
.pgdata-test/
*.log
*.err
.DS_Store
.beads.gate.lock
.<NUL>pgdata-drill/<UTF-16LE><CRLF><NUL>      <-- line 15, inert as a glob
```

Byte evidence (hex, tail of the file):

```
2e 00 70 00 67 00 64 00 61 00 74 00 61 00 2d 00 64 00 72 00 69 00 6c 00 6c 00 2f 00 0d 00 0a 00
```

i.e. the ASCII `.` followed by `pgdata-drill/` encoded as **UTF-16LE** (`2e 00` … `2f 00`), then a
UTF-16 CRLF and a trailing NUL. The whole file ended on a NUL byte.

### After (375 bytes, clean UTF-8, LF endings, no BOM, no NUL bytes)

```
node_modules/
dist/
coverage/
!docs/coverage/
!docs/coverage/**
.env
.env.*
!.env.example

# Local PostgreSQL data directories (embedded-postgres clusters).
# .pgdata       -> scripts/dev-db.mjs
# .pgdata-test  -> test/global-setup.ts
# .pgdata-drill -> scripts/upgrade-restore-drill.ts
.pgdata*/
.pgdata/
.pgdata-test/
.pgdata-drill/

*.log
*.err
.DS_Store
.beads.gate.lock
```

Every pre-existing protective rule was kept verbatim (`node_modules/`, `dist/`, `coverage/` +
the two `!docs/coverage` un-ignores, `.env`, `.env.*`, `!.env.example`, `.pgdata/`, `.pgdata-test/`,
`*.log`, `*.err`, `.DS_Store`, `.beads.gate.lock`). Only the corrupted line was replaced and the
PostgreSQL rules were extended.

### Verification

```
$ git check-ignore -v .pgdata-drill
.gitignore:17:.pgdata-drill/	.pgdata-drill        (exit 0)

$ git status --porcelain --ignored=matching | grep pgdata
!! .pgdata-drill/
!! .pgdata-test/
!! .pgdata/

$ git status --porcelain | grep pgdata
(no output — .pgdata-drill/ is no longer listed as untracked)
```

**Note on a misleading signal:** with the corrupted file in place, `git check-ignore -v ".pgdata-drill/"`
(a path *with* a trailing slash) exited 0 and printed `.gitignore:16: .pgdata-drill/`, which looks like
a working rule. It was not: `git check-ignore -v ".pgdata-drill"` (no trailing slash) exited 1,
`git check-ignore -v ".pgdata-drill/PG_VERSION"` exited 1, and `git status` reported `?? .pgdata-drill/`.
The trailing-slash form is an artefact of the NUL-embedded bytes and must not be used as evidence of a
working rule.

## 2. PostgreSQL directory names actually produced by this project

Read from the project's own scripts (not invented):

| Directory | Source | Detail |
|---|---|---|
| `.pgdata` | `scripts/dev-db.mjs:5,10` | `const dataDir = ".pgdata"` → `databaseDir: dataDir` (embedded-postgres, persistent) |
| `.pgdata-test` | `test/global-setup.ts:41,68` | `const dataDir = ".pgdata-test"` → `databaseDir: dataDir` (vitest global setup) |
| `.pgdata-drill` | `scripts/upgrade-restore-drill.ts:18,53` | `const DATA_DIR = ".pgdata-drill"` → `databaseDir: DATA_DIR` (upgrade/restore drill) |

Supporting evidence that these are the only ones: `eslint.config.mjs:5` already ignores
`.pgdata*/**`, i.e. the project itself treats `pgdata*` as the prefix family. `.pgdata*/` was added
to `.gitignore` as a catch-all for that same prefix (no new *specific* names invented); the three
concrete names are listed explicitly above them so `git check-ignore` reports the exact rule.

## 3. The guard — `scripts/guard-repo-hygiene.mjs` (new)

Pure Node, no new dependencies (`node:child_process` only). Exit codes: `0` clean, `1` violations
found, `2` the guard could not run (not a git working tree, git failure).

### Rule list (one line)

> **PostgreSQL cluster artifacts** — any path inside the known local data dirs `.pgdata/`,
> `.pgdata-test/`, `.pgdata-drill/`; any PostgreSQL-internal directory segment (`pg_wal`, `pg_xact`,
> `pg_stat`, `pg_subtrans`, `pg_multixact`, `pg_twophase`, `pg_commit_ts`, `pg_logical`, `pg_notify`,
> `pg_serial`, `pg_snapshots`, `pg_dynshmem`, `pg_replslot`, `pg_tblspc`, …); the cluster layouts
> `base/<oid>` and `global/pg_*`; and the cluster files `PG_VERSION`, `postgresql.conf`,
> `postgresql.auto.conf`, `postmaster.pid`, `postmaster.opts`, `pg_control`, `pg_ident.conf`,
> `pg_hba.conf`, `pg_filenode.map`, `backup_label`, `tablespace_map` — **plus** **secrets**
> (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.truststore`,
> `id_rsa*` except `.pub`, `credentials.json`, `secrets.*`/`secret.*`, `.npmrc`, `.pypirc`) —
> **plus** **media / archives** (`.png .jpg .jpeg .gif .webp .bmp .tiff .mp4 .mov .avi .mkv .webm
> .zip .tar .gz .tgz .7z .rar`) — **plus** **oversized blobs** (> 2 MiB) — with `.env.example` and
> any `*.example[.ext]` allowed through.

### How it works (and how it stays secret-safe)

- Tracked files only: `git ls-files -s -z` (the index), never the working tree.
- Real blob sizes via git plumbing: `git ls-files -s` → `git cat-file --batch-check` over the blob
  ids. **No file content is ever read into memory.**
- The report prints **path + reason only** — never file contents. Example output:

  ```
  guard-repo-hygiene: 1 violation(s) in tracked files:

    .pgdata-drill/PG_VERSION
        -> inside the local PostgreSQL data directory ".pgdata-drill"

  guard-repo-hygiene: remove these paths from the index (or ignore them) before committing.
  guard-repo-hygiene: only paths and reasons are printed — contents are never read or shown.
  ```

- No remote is used, no network, no `git fetch` — safe in a shallow/partial clone (missing blobs are
  reported as "unknown size" rather than crashing).
- Usage: `node scripts/guard-repo-hygiene.mjs [--repo <path>]` (also honours `GUARD_REPO_ROOT`).
  The `--repo` flag is what lets the test point it at a throwaway repository.

### Current-tree result

```
$ npm run guard:hygiene
guard-repo-hygiene: OK — 205 tracked file(s) inspected, no violations.   (exit 0)
```

## 4. CI wiring

`.github/workflows/ci.yml` — the `quality` job, immediately after `npm ci` and **before** lint, so a
leak fails fast:

```yaml
      - run: npm ci --no-audit --no-fund
      - name: Repo hygiene guard
        run: npm run guard:hygiene
      - run: npm run lint
```

No existing job or step was weakened or removed; the `smoke` job is untouched.

`package.json` — one new script, no dependency or script changes:

```json
"guard:hygiene": "node scripts/guard-repo-hygiene.mjs"
```

## 5. Pre-commit hook (optional, NOT installed)

`.githooks/pre-commit` (new, 566 bytes) runs the same guard against the staged index:

```sh
exec node scripts/guard-repo-hygiene.mjs
```

**Install note (one line, repo-local only — I did NOT run it and did NOT touch your global git
config or `.git/config`):**

```
git config core.hooksPath .githooks
```

CI remains the authoritative gate; the hook is a local convenience.

## 6. Test — `test/ops/guard-repo-hygiene.test.ts` (new)

Vitest (already the runner; `vitest.config.ts` includes `test/**/*.test.ts`). Each violation is
planted in a **throwaway git repository under the OS temp directory** — never in this repository —
and the guard is executed as a real child process, so the exit code is genuinely asserted.

Test names:

1. `exits zero on a clean tree`
2. `exits zero on this repository's own tracked files`
3. `exits non-zero when a tracked PostgreSQL cluster file is present` — plants `.pgdata-drill/PG_VERSION`
4. `exits non-zero for a PostgreSQL cluster committed under an unknown directory name` — plants
   `some-cluster/base/1/24576` and `some-cluster/PG_VERSION` (proves the structural rules catch a
   cluster committed under a name the project does not even use)
5. `exits non-zero when a tracked secret file is present and never prints its contents` — plants a
   `.env` containing `SUPER_SECRET_TOKEN=do-not-log-me` and asserts the output contains neither
   `SUPER_SECRET_TOKEN` nor `do-not-log-me`
6. `exits non-zero for a tracked media file and for a tracked oversized blob` — plants `assets/logo.png`
   and a 3 MiB `data/dump.bin` (the size rule is exercised through real git blob sizes)
7. `allows the tracked example files to pass` — plants `.env.example`, expects exit 0

Result (this lane's own run):

```
$ npx vitest run test/ops/guard-repo-hygiene.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

The negative half was proven empirically, not just asserted: on the first run the planted
`.pgdata-drill/PG_VERSION` case **did** fail the suite (the guard printed
`-> inside the local PostgreSQL data directory ".pgdata-drill"` and exited 1) — the assertion text
was then corrected, and the case for a cluster under an unknown directory name was added.

## 7. Validation performed

| Check | Command | Result |
|---|---|---|
| Guard on real tree | `node scripts/guard-repo-hygiene.mjs` | exit 0, "OK — 205 tracked file(s) inspected" |
| Guard outside a repo | `node scripts/guard-repo-hygiene.mjs --repo %TEMP%` | exit 2, clear message |
| Guard `--help` | — | exit 0, usage printed |
| New test | `npx vitest run test/ops/guard-repo-hygiene.test.ts` | 7/7 passed |
| Full suite | `npm test` | **246/246 passed, 20/20 files, exit 0** (one earlier run had a single flake in `test/use-cases.integration.test.ts` — "expected 1 to be greater than or equal to 2" in the notification-feed assertion; that file passes 8/8 in isolation and the full suite passed on re-run, so it is a pre-existing order/parallel flake unrelated to this lane, which touches no application code) |
| Typecheck | `npm run typecheck` | exit 0 (includes the new test file) |
| Lint of new files | `npx eslint scripts/guard-repo-hygiene.mjs test/ops/guard-repo-hygiene.test.ts` | exit 0, no findings |
| Repo-wide lint | `npm run lint` | **exit 1 — pre-existing, other lanes' files only** (`apps/web/src/workspaces/CustomerWorkspace.tsx` 5× `no-unused-vars`, `test/scenarios/p0.integration.test.ts` 1 warning). Those files are modified/untracked by other lanes; my files are clean. |
| Ignore repair | `git check-ignore -v .pgdata-drill` | `.gitignore:17:.pgdata-drill/` (exit 0) |
| Ignore repair | `git status --porcelain --ignored=matching` | `!! .pgdata-drill/` (was `?? .pgdata-drill/`) |

## 8. Leftover scaffolding — `apps/web/src/App.tsx.bak`

Confirmed present, untracked (`?? apps/web/src/App.tsx.bak`) and **not imported anywhere** in the
repo (a repo-wide search for `App.tsx.bak` matches only briefs/reports, never an import). It is a
leftover backup from a previous UI refactor and is **safe to delete** — but `apps/web/**` belongs to
Lane B, so per the brief I did **not** delete it. **Action for the integrator/Lane B: remove
`apps/web/src/App.tsx.bak`.**

## 9. Concerns / remaining risks

1. **The guard blocks legitimate media.** Any future tracked image/video/archive (e.g. a favicon or a
   screenshot in `docs/`) will fail CI. There is currently no allowlist mechanism; if the project
   needs one, the integrator should add an explicit, reviewed allowlist to the script rather than
   weakening the media rule.
2. **Thresholds are hardcoded** in the script (2 MiB blob cap, extension lists, PostgreSQL cluster
   file/dir names). Changing them means editing `scripts/guard-repo-hygiene.mjs`.
3. **The pre-commit hook is inert until the user runs `git config core.hooksPath .githooks`**
   (repo-local). I did not install it and did not modify `.git/config` or any global config.
4. **The test creates throwaway git repositories** under the OS temp directory and stages files in
   *those* repos with `git add` (no commit, no remote). This repository's index, history and
   remotes were never touched — no `git add`/`commit`/`rm --cached`/`push` was run here.
5. **This lane does not address the public exposure itself.** The guard prevents *new* leaks; the
   already-public exposure of `.pgdata-drill/` (if the public repository really contains it — this
   working tree has no remote, so it could not be verified) and any history purge remain the
   integrator's decision and need explicit owner authorisation. `.pgdata-drill/` was **left on disk
   untouched** (still present, now correctly ignored).
6. **Repo-wide `npm run lint` currently fails** in `apps/web/**` and `test/scenarios/**` — other
   lanes' in-progress work, not this lane's files. The `quality` CI job runs lint before/after my
   step, so CI may still be red for that unrelated reason.
7. **Pre-existing test flake** in `test/use-cases.integration.test.ts` (notification feed count)
   surfaced once during a full-suite run and did not reproduce (8/8 in isolation; full suite
   246/246 on re-run). Not caused by this lane, but it can make the `quality` job red
   intermittently.
