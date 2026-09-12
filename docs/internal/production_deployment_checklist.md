# Production/Cloud Deployment Checklist

Condensed, actionable checklist distilled from the local pilot deployment
(`docs/deployment_notes_saile.md` has the full narrative — every item below
links back to the section that explains *why*, if you need the reasoning
or troubleshooting detail behind it). Use this as the working checklist for
the real server or cloud deployment; use the narrative doc when something
here doesn't go as expected.

Related docs: `docs/internal/fork_notes.md` (upstream sync process),
`docs/internal/deployment_integration_plan.md` (topology/ingest design),
`docs/internal/known_issues.md` (upstream bugs and their fixes),
`docs/docker_issue.md` (standalone write-up of the host-level Docker/snap
AppArmor bug — general-purpose, not Coyote3-specific).

---

## 0. Host prerequisites — check before anything else

- [ ] **Docker installation method**: run
  `docker info | grep -i "Docker Root Dir"`. If the path is under
  `/var/snap/docker/...`, this host has the same problem the pilot machine
  had — a snap-packaged Docker's AppArmor confinement blocks
  `stop`/`kill`/`restart` on every container, host-wide (not app-specific).
  **Install `docker-ce`/`docker-ce-cli`/`containerd.io`/
  `docker-compose-plugin` from Docker's official apt/yum repository
  instead**, before bringing up any stack. Full root cause and fix
  recipe: `docs/docker_issue.md`.
- [ ] Confirm `docker compose version` (v2 plugin, not the standalone
  `docker-compose` v1 binary).
- [ ] Decide and record: on-prem vs. cloud VM, and the storage host paths
  (equivalent of this pilot's `COYOTE3_DATA_HOST_ROOT` /
  `COYOTE3_LOGS_HOST_ROOT` / `COYOTE3_MONGO_DATA_HOST_ROOT`) — do not reuse
  the pilot's `/home/saile/develop/coyote_data` paths or UID/GID values,
  re-derive for the real host and its actual service account.
- [ ] Confirm outbound firewall/network rules needed (LAN vs. public,
  TLS termination point) — nothing about Coyote3 itself opens firewall
  ports (deployment notes §9); this is entirely the operator's
  responsibility on every host.

## 1. Environment file

- [ ] Copy `deploy/env/example.env` (or the topology-matching variant) to
  a new, real, gitignored env file — never commit it.
- [ ] Generate fresh secrets for this deployment — do **not** copy any
  secret from the pilot's `.coyote3_env`: `SECRET_KEY`,
  `INTERNAL_API_TOKEN`, `PASSWORD_TOKEN_SALT`, `REDIS_PASSWORD` (≥64 hex
  chars — `openssl rand -hex 32`), `MONGO_ROOT_PASSWORD`,
  `MONGO_APP_PASSWORD`, and the Mongo keyfile (`openssl rand -base64 756`,
  `chmod 600`).
- [ ] Set `ENV_NAME` correctly — only `development`/`production`/
  `testing`/`staging` are valid (deployment-level; do **not** confuse with
  the per-sample `environment` field, which additionally allows
  `validation` — different concept, caught the hard way in the pilot,
  deployment notes §3).
- [ ] Set real `ORGANIZATION_NAME`, `PUBLIC_BASE_URL`,
  `COYOTE3_NGINX_PUBLIC_SCHEME` (almost certainly `https` in real
  deployment — the pilot ran plain HTTP on a LAN only, deployment notes
  §9, and that choice does not carry forward).
- [ ] Run `scripts/validate_env_secrets.sh --env-file <file>` — catches
  placeholder/too-short secrets before first `up`.
- [ ] All `scripts/*.sh` in this repo are committed without the executable
  bit (upstream packaging quirk, not host-specific) — always invoke as
  `bash scripts/whatever.sh ...`, not `./scripts/whatever.sh`.

## 2. MongoDB

- [ ] Decide topology (single shared `mongod` vs. split instances) — the
  pilot used a single shared `mongod` for all four logical databases.
- [ ] Create the Docker network:
  `docker network create <COYOTE3_APP_NETWORK value>`.
- [ ] Bring up Mongo:
  `bash scripts/compose-with-version.sh -f deploy/compose/docker-compose.mongo.yml --env-file <file> --profile mongo up -d`
- [ ] If bootstrapping from the host shell (not from inside the Docker
  network), use `directConnection=true` on the Mongo URI, not
  `replicaSet=...` — the replica set advertises its Docker-internal
  hostname, which is unresolvable from outside the network (deployment
  notes §7). The running application containers use the full
  `replicaSet=` URI correctly and need no special handling.

## 3. Bootstrap RBAC and reference data

- [ ] `bash scripts/bootstrap_database.py --with-demo-center` **only** for
  a first smoke-test pass — re-run **without** `--with-demo-center` (or
  skip entirely and author real ASP/ASPC/ISGL content) for the actual
  production database. Never re-run bootstrap against a populated DB.
- [ ] Use distinct email addresses for the superuser and sys_admin
  accounts (the script refuses a collision).
- [ ] Force password change on first login for both bootstrap accounts.

## 4. Full stack bring-up

- [ ] `bash scripts/compose-with-version.sh -f deploy/compose/docker-compose.yml --env-file <file> up -d --build`
- [ ] `bash scripts/center_preflight.sh` — note it doesn't derive
  `COYOTE3_IMAGE_TAG` the same way `compose-with-version.sh` does; export
  it manually first if running preflight standalone (deployment notes §8).
- [ ] Confirm `GET /api/v1/health` → `{"status":"ok"}` through the real
  proxy, not just container-internal.
- [ ] Log in as the bootstrap superuser through an actual browser (not
  just the API) and confirm the forced password-change screen works.

## 5. Apply known upstream issues proactively

- [ ] **KI-001** (`docs/internal/known_issues.md`): if deploying with no
  `SCRIPT_NAME` URL prefix (root-path deployment), confirm
  `deploy/compose/nginx/render-config.sh`'s fix is present — every static
  asset request must return its own correct content-type, not
  `index.html`. Verification snippet is in the KI-001 doc. This fix is
  committed on `center/main`; if syncing from a fresh upstream checkout,
  re-apply it, then re-verify with a **real** `docker compose up -d
  --build` (not a live config patch) before considering it done. Consider
  reporting this upstream to SMD Lund if not already done.

## 6. Center-specific configuration (replace ALL pilot placeholder values)

- [ ] `api/config/center/contact.toml` — real organization name,
  department, support contacts. (Pilot used placeholder
  `@ourcenter.example.org` addresses — these must not reach production.)
- [ ] `frontend/src/components/layout/BrandWordmark.tsx` reads
  `runtimeConfig.organizationName` automatically — just confirm
  `ORGANIZATION_NAME` is set correctly in the env file; no code change
  needed per center.
- [ ] `api/config/center/clinical_vocabulary.toml`,
  `clinical_query_policy.toml`, `filter_flag_metadata.yaml` — review
  against the real pipeline's vocabulary/filter conventions.
- [ ] Any code-level config change requires a real image rebuild
  (`COPY api/ ./api/` in `docker/Dockerfile` bakes it in at build time,
  loaded once into a module-level Python constant — there is no
  live-reload path). `deploy/compose/nginx/render-config.sh` is the one
  exception (bind-mounted, live-editable) — everything else needs
  `up -d --build` plus a real container recreate to take effect.
- [ ] RBAC: create real operational roles via `POST /api/v1/roles` (or the
  admin UI) rather than editing bootstrap catalogs directly. Remember the
  admin resource-form API contract: payloads must be wrapped as
  `{"form_data": {...fields...}}`, not flat JSON (deployment notes §14) —
  this generic pattern likely applies to ASP/ASPC/ISGL admin endpoints too.

## 7. Ingest integration

- [ ] Decide file-drop (watched directory, `COYOTE3_INGEST_WATCH_*` env
  vars) vs. token-authenticated API upload
  (`POST /api/v1/internal/ingest/sample-bundle/upload[/async]` with
  `X-Coyote-Ingest-Token`) per pipeline — both were validated end-to-end
  in the pilot (deployment notes §11–§12); the token path is the right
  choice for large files or a pipeline running on separate infrastructure.
- [ ] Remember `environment_storage_root()` namespaces all ingest/storage
  paths under `/data/coyote3_<env-short-name>/`, not flatly under `/data/`
  — derived from `ENV_NAME` (`api/config/paths.py`).
- [ ] Validate every manifest shape against `scripts/validate_ingest_spec.py`
  before wiring automated submission.
- [ ] Remember: BAM/CRAM files are **never** transported through Coyote3
  — only filenames are stored. IGV resolution is a separate concern
  (`IGV_DATA_ROOT` + ASP `igv` config) — plan that storage/access path
  independently of ingest transport.

## 8. Explicitly NOT resolved by the pilot — decide before go-live

- [ ] Real hosting target (on-prem vs. cloud, exact host/VM).
- [ ] LDAP integration (pilot used local accounts only).
- [ ] SMTP relay (not configured in the pilot; app starts fine without it,
  but notifications/password-reset need it for real use).
- [ ] Knowledgebase licensing, especially OncoKB (account/API token with
  its own license terms) — CIViC/COSMIC/BRCA Exchange/IARC TP53/HGNC/
  ClinPGx are open-data adapters via `scripts/update_*.py`.
- [ ] TLS/HTTPS termination (pilot ran plain HTTP on a private LAN only —
  not acceptable for a real deployment).
- [ ] Backup/restore rehearsal for all four logical Mongo databases
  (`scripts/mongo_backup_archive.sh` / `mongo_restore_archive.sh`) —
  never exercised in the pilot.
- [ ] A real clinical validation study appropriate to your jurisdiction's
  regulatory framework (see `NOTICE.txt`) — the pilot only proved the
  software mechanics work, not clinical correctness of any specific
  configuration.

## 9. Final sign-off before calling it "live"

- [ ] Full quality gate green: `scripts/run_quality_suite.sh`.
- [ ] `scripts/center_check.sh` end-to-end smoke check passes.
- [ ] A real (not demo) sample ingested, filtered, tiered, and taken
  through report preview by an actual geneticist/lab-staff reviewer, not
  just via the API.
- [ ] Everyone who'll operate this day-to-day has read
  `docs/deployment_notes_saile.md` for the "gotchas we already hit" —
  especially §3 (`ENV_NAME` vs. sample `environment`), §7 (host-side Mongo
  connection needs `directConnection=true`), and §16 (check Docker
  packaging method first, on *any* new host).
