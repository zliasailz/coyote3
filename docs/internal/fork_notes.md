# Fork Notes

This document tracks every place our deployment diverges from the
`SMD-Bioinformatics-Lund/coyote3` upstream, so that merging future upstream
releases stays tractable. It is maintained on the `center/main` branch and
its descendants, not merged upstream.

Do not record center configuration values here (assay panels, gene lists,
contacts, branding text) — those live in `api/config/center/`, DB-managed
ASP/ASPC/ISGL records, and runtime config. This file is only for **code**
changes that diverge from upstream product behavior.

## Base architecture

`center/main` is built on the `api` branch (the FastAPI + React v4.0.0
rewrite), **not** `master` (the released v3.1.x Flask/Jinja2 line). `api` is
a linear descendant of `master` — 241 commits ahead as of the point this
branch was cut — but it is still pre-release upstream: expect ongoing
upstream churn and no stability guarantees until SMD Lund tags a v4.0.0
release.

## Remotes

- `origin` — our fork: `https://github.com/zliasailz/coyote3.git`
- `upstream` — SMD Lund: `https://github.com/SMD-Bioinformatics-Lund/coyote3.git`
- Base branch for our customization work: `center/main` (branched from
  `upstream/api`).

## Upstream sync process

1. `git fetch upstream`
2. Merge or rebase `upstream/api` into `center/main` (prefer merge to
   preserve a clear history of what came from upstream vs. our changes).
   Confirm upstream hasn't merged `api` into `master` and retired the
   branch name before fetching.
3. Re-run `scripts/run_quality_suite.sh`.
4. Re-run `scripts/sync_rbac_catalog.py` against a non-production environment
   if the upstream change touched `api/config/bootstrap/rbac`.
5. Review this file — resolve or update any entries affected by the sync.

## Divergences from upstream

| Date | Area | File(s) | Reason | Status |
| --- | --- | --- | --- | --- |
| 2026-09-12 | nginx proxy | `deploy/compose/nginx/render-config.sh` | Root-path (`SCRIPT_NAME=''`) deployments served `index.html` for every static asset instead of the asset itself — full root-cause, fix, reproduction, and verification in [`docs/internal/known_issues.md` § KI-001](known_issues.md#ki-001-root-path-nginx-deployments-silently-serve-indexhtml-for-every-static-asset). | Source fixed on `center/main`; verified via a full `docker compose up -d --build` recreate (not just a live patch). Not yet reported to SMD Lund. |

Add a row per code-level change made under Phase 8 of the implementation
roadmap (custom code changes only where configuration cannot express the
requirement). Link the internal ticket/PR if one exists.
