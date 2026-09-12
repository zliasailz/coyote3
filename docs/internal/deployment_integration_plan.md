# Deployment and Ingest Integration Plan

Records our center's Phase 2/6 decisions (see the adoption roadmap) for
on-premises deployment and pipeline integration. No secrets or real hostnames
belong in this file — those live only in the local, gitignored `.coyote3_env`.

## Topology decisions

- **Hosting**: on-premises servers, using the Docker Compose stack as-is.
- **MongoDB**: single shared `mongod` container
  (`deploy/compose/docker-compose.mongo.yml`, `mongo` profile only — omit
  `mongo-kb`). All four logical databases (`primary`/app, `identity`,
  `knowledgebase`, `bam`) live on this one replica-set member as separate
  database names. See `docs/architecture/mongodb_topology.md`.
- **Auth**: local accounts only for now (`AUTHENTICATION_PROVIDERS='local'`).
  LDAP can be enabled later purely through environment/config — no code
  change needed.

## Bring-up sequence (this topology)

```bash
# 1. Prepare host directories and the Mongo keyfile (root-owned, 0600) before
#    any container starts — first-run user creation only happens against an
#    empty data directory.
# 2. Start Mongo and initialize its replica set:
./scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d mongo
./scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo run --rm mongo_init

# 3. Bootstrap RBAC/reference data (do NOT use --with-demo-center in production):
PYTHONPATH=. .venv/bin/python scripts/bootstrap_database.py

# 4. Start the application stack:
./scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d --build

# 5. scripts/center_preflight.sh and scripts/center_check.sh before declaring
#    the environment ready.
```

Add `-f deploy/compose/docker-compose.mongo-backup.yml` once
`COYOTE3_MONGO_BACKUP_HOST_ROOT` exists, and a private
`.coyote3_storage.yml` (copied from `docker-compose.storage.example.yml`) for
any read-only center input mounts.

## Ingest integration design

Two independent transport choices exist for the sample YAML manifest + its
declared analysis files (`vcf_files`, `cnv`, `cov`, `fusion_files`, etc.).
**Neither ever transports BAM/CRAM** — see below.

| | File-drop (watched directory) | Remote/API (governed token) |
| --- | --- | --- |
| Fits | Pipeline runs on infrastructure with shared filesystem access to the Coyote3 hosts | Pipeline runs on separate infrastructure with only network access |
| Mechanism | Celery beat scans `INGEST_WATCH_DIR` for `coyote3.yaml`; declared file paths must resolve under `COYOTE3_DATA_HOST_ROOT` (identically mounted at that same absolute path in API/worker/beat containers) | `POST /api/v1/internal/ingest/sample-bundle/upload` (sync) or `/upload/async` (queued) with a `yaml_file` + optional `data_archive` ZIP (≤20GB uncompressed, ≤1000 files) bundling the manifest's declared files |
| Auth | N/A (local watcher, trusted host) | `X-Coyote-Ingest-Token` header — short-lived (1–720h), signed, scoped to `sample-ingest` + one environment, minted via `POST /api/v1/admin/ingest-tokens` (permission `ingest.token:issue`), every issuance audited |
| Config | `COYOTE3_INGEST_WATCH_ENABLED=1` + watch-interval/suffix vars | No extra env beyond the running API; caller supplies the token per submission |

Our plan: **file-drop** for pipeline runs on our own infrastructure (the
common case), **token + ZIP-archive upload** for any pipeline stage that runs
on infrastructure without a shared mount to the Coyote3 hosts (e.g. a
separate sequencing facility, cloud burst compute, or a partner lab
submitting cases to us).

### BAM/CRAM: a separate, ingest-independent storage plan

Coyote3's sample manifest only ever stores BAM/BAI **filenames**
(`case_bam`, `case_bai`, ...) — it never parses, copies, or requires ingest
access to the alignment files themselves. IGV resolves them at view-time
against:

- the ASP's `igv.base_folder` / `igv.bam_subfolder` configuration (Admin >
  Assay Panels > Alignment viewer), and
- the deployment's `IGV_DATA_ROOT`, a workstation-visible root (a mapped
  drive letter or POSIX path) that must be reachable **from lab
  workstations**, independent of whatever transport got the VCF/JSON files
  into Coyote3.

Action item: decide and provision this alignment-file share (NAS/SMB mount,
capacity, retention) as its own project — it is not solved by choosing
file-drop vs. API ingest, and matters equally for both.

## Open items still needed from us

1. Real production hostnames/IPs for `PUBLIC_BASE_URL`, the reverse-proxy/TLS
   arrangement in front of nginx, and `FORWARDED_ALLOW_IPS`.
2. Real host paths for `COYOTE3_DATA_HOST_ROOT`, `COYOTE3_LOGS_HOST_ROOT`,
   Mongo data/keyfile/backup roots, and the production host's app-owner
   UID/GID (`COYOTE3_UID`/`COYOTE3_GID`, `MONGO_UID`/`MONGO_GID`).
3. The BAM/CRAM alignment-file share described above.
4. SMTP relay details (notifications/password-reset degrade without it, but
   the stack still starts).
5. Which pipeline stages, if any, run off our own infrastructure and need the
   token-based remote submission path from day one vs. later.
