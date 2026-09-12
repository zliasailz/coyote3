# Deployment Notes (saile) — Pilot Setup Journal

Working notes from standing up a Coyote3 pilot on a local machine before
real server/cloud deployment. Coyote3 already has extensive product
documentation (`docs/start_here/`, `docs/operations/`,
`docs/architecture/`); this file is a personal, chronological howto
covering *this specific adoption effort* — decisions made, problems hit,
and exactly how they were resolved — so the reasoning survives even though
none of it is required reading to run the application.

See also: `docs/internal/fork_notes.md` (upstream sync process),
`docs/internal/deployment_integration_plan.md` (topology/ingest design),
`docs/docker_issue.md` (standalone write-up of the host-level Docker/snap
AppArmor bug in §16 — not specific to Coyote3, worth keeping even if
these notes become stale), `.claude.plan.md` (the live phase-by-phase
task list).

## Context

We're adopting Coyote3 (SMD Lund's clinical genomics variant tiering/
reporting app) at our own genomic center: a new capability (no prior
system), config-first with light code changes maintained as a private
fork, all assay types eventually, run by a dedicated bioinformatics/infra
team. This document tracks the pilot phase: proving the whole stack works
end-to-end on a local machine before committing to real hosting.

## 1. The fork/branch mixup — and how it was found and fixed

**What happened**: the repository we started from had `origin` pointing
directly at `https://github.com/SMD-Bioinformatics-Lund/coyote3.git`, with
the working tree checked out on branch `api`. The first step was to fork
this to our own GitHub account and create a dedicated `center/main` branch
for our customization work. That branch was cut with:

```bash
git checkout -b center/main origin/master
```

using `master` because it's the conventional "stable" branch name. This
was wrong.

**How it was caught**: after switching to `center/main`, a routine `ls`
showed a completely different file layout than what we'd been exploring —
no `api/`, no `frontend/`, no `AGENTS.md`; instead `coyote/`, `config.py`,
`wsgi.py`. Comparing branches confirmed why:

```bash
git log --oneline -5 upstream/master   # HEAD: v3.1.22, "Flask" per README
git merge-base upstream/master upstream/api   # == upstream/master's HEAD
git log --oneline upstream/master..upstream/api | wc -l   # 241
git log --oneline upstream/api..upstream/master | wc -l   # 0
```

`master` is the **released v3.1.x Flask/Jinja2 monolith** — Coyote3's
current production line at SMD Lund. `api` is a **linear descendant of
master, 241 commits ahead**, containing an in-progress, unreleased
rewrite to FastAPI + React + Pydantic + Casbin RBAC (versioned 4.0.0 in
its README). Everything in our adoption plan — ASP/ASPC/ISGL, the
governed clinical rules engine, the FastAPI layering — describes the `api`
architecture, since that's what was actually shown to us and explored.
Building `center/main` on `master` would have quietly put us on the wrong,
architecturally unrelated generation of the product.

**The fix**:

```bash
git fetch upstream api
git reset --hard upstream/api      # center/main now sits on api's tip
# re-create any commits made on the wrong base (here: docs/internal/fork_notes.md)
git add docs/internal/fork_notes.md
git commit -m "..."
git push --force-with-lease origin center/main
```

Because `master` is an ancestor of `api` (not an unrelated history), this
was a clean rebase-equivalent fix — only one throwaway commit was lost,
force-pushed to our own fork with no other collaborators on that branch
yet.

**Lesson**: when a project has an in-progress major-version rewrite living
on a non-`master` branch, don't assume `master` is "the stable base to
fork from" — check `git log`/`git merge-base` between the branch you've
actually been shown and the default branch before cutting any customization
branch.

## 2. No GitHub credentials in the assistant's sandbox

The environment Claude Code's Bash tool runs in has no GitHub
authentication (no token, and the local `~/.ssh/id_ed25519` key isn't
registered with GitHub) — `git push` fails with `Permission denied
(publickey)` even though this is the same working directory as the normal
interactive shell. Working pattern: Claude prepares commits locally
(`git add`/`git commit`), and pushes are run manually from an authenticated
terminal:

```bash
git push -u origin center/main                    # first push
git push --force-with-lease origin center/main     # after the rebase fix above
```

After a manual push, the local `origin/<branch>` tracking ref updates
immediately (same `.git` directory) — no `git fetch` needed to see it, but
`git fetch` itself will still fail with the same publickey error if
attempted from Claude's shell. That's expected, not a sign the push
didn't work — check `git rev-parse HEAD origin/<branch>` for equality
instead.

## 3. MongoDB topology and environment file

Decided: **on-premises**, **single shared `mongod`** container hosting all
four logical databases (`primary`/app, `identity`, `knowledgebase`, `bam`)
as separate database names on one replica set — see
`docs/architecture/mongodb_topology.md` and
`docs/internal/deployment_integration_plan.md` for the reasoning and exact
bring-up command sequence (`docker-compose.mongo.yml`, `mongo` profile
only, no `mongo-kb`).

`.coyote3_env` (gitignored, never committed) was built from
`deploy/env/example.env` + `deploy/env/example.mongo-local.env`, adapted
for the single-container Mongo topology. Secrets were generated locally:

```bash
openssl rand -hex 32   # SECRET_KEY, INTERNAL_API_TOKEN, PASSWORD_TOKEN_SALT, REDIS_PASSWORD
openssl rand -hex 24   # MONGO_ROOT_PASSWORD, MONGO_APP_PASSWORD
openssl rand -base64 756 > <keyfile path>; chmod 600 <keyfile path>   # Mongo keyfile
```

`scripts/validate_env_secrets.sh --env-file .coyote3_env` caught a real
mistake here: `REDIS_PASSWORD` specifically must be ≥64 hex characters
(`openssl rand -hex 24` only produces 48), while the script doesn't enforce
a length on the Mongo passwords. Worth running that script on any new env
file before first `up`, not just once at the end.

**Second mistake, caught before running anything**: initially set
`ENV_NAME=validation`, reasoning that `docs/api/sample_yaml.md` lists
`validation` as a supported environment value. That document describes the
*per-sample* `environment`/`profile` field (production/development/
testing/validation) — a different concept from the *deployment-level*
`ENV_NAME`. Reading `scripts/compose-with-version.sh` directly showed it
maps `ENV_NAME` through `{"development":"dev","production":"prod",
"testing":"test","staging":"stage"}` and then hard-fails if the result
isn't one of `dev/prod/test/stage` — `validation` would have aborted the
very first `up`. Switched to `ENV_NAME=staging` instead (full-stack
validation without being the real production deployment), with the
matching database name suffixes (`coyote3_stage`,
`coyote3_identity_stage`, `bam_stage`) per
`docs/architecture/mongodb_topology.md`'s own staging example.

**Lesson**: the same English word (`environment`) means two different,
independently-validated things in this codebase depending on layer —
worth greping the actual enforcing code (not just the first doc that uses
the word) before trusting a value into a deployment file.

## 4. Ingest architecture — what "remote/big-file submission" actually means here

Initial assumption going in: "file-drop for normal results, a remote API
for big files." That's not quite how Coyote3 splits it. Investigated
`api/tasks/ingest.py`, `api/security/ingest_tokens.py`,
`api/application/ingest/tokens.py`,
`api/application/ingest/upload_archive.py`,
`api/interfaces/http/operations/internal.py`, and
`docs/api/sample_yaml.md` to confirm:

- **File-drop**: Celery beat scans a watched directory
  (`$COYOTE3_DATA_HOST_ROOT/copied_sample_files/yaml/coyote3.yaml`) for
  manifests whose declared file paths resolve under the same host-mounted
  data root.
- **Remote/API**: `POST /api/v1/internal/ingest/sample-bundle/upload`
  (sync) or `.../upload/async` (queued) accepts a `yaml_file` manifest plus
  an optional `data_archive` ZIP (up to 20GB uncompressed, 1000 files),
  extracted server-side and matched to the manifest's declared file keys.
  Authenticated with a short-lived, signed `X-Coyote-Ingest-Token`
  (1–720h, scoped to one environment, minted via
  `POST /api/v1/admin/ingest-tokens` with the `ingest.token:issue`
  permission, every issuance audited) — or the deployment-wide
  `X-Coyote-Internal-Token`, or a regular authenticated session with
  `internal.ingest:manage`.
- **BAM/CRAM never goes through either path.** The manifest only stores
  filenames (`case_bam`, `case_bai`); IGV resolves them at view-time
  against a completely separate, workstation-visible root
  (`IGV_DATA_ROOT` + the ASP's `igv.base_folder`/`bam_subfolder` config).
  This needs its own shared-storage plan (NAS/SMB share reachable from lab
  workstations) regardless of which ingest path is used for everything
  else.

So the real design axis is "shared-filesystem path reference" vs. "HTTP
upload of an archive," not "small file vs. big file" — and alignment
files sit entirely outside both.

## 5. Pilot storage layout — separated from the app repo

All pilot/ingest data lives under `/home/saile/develop/coyote_data/`,
fully separate from the application checkout at
`/home/saile/develop/coyote3/`:

```text
/home/saile/develop/coyote_data/
├── app-data/                          → COYOTE3_DATA_HOST_ROOT (mounted at /data)
│   ├── copied_sample_files/yaml/      → watched manifest directory (fixed subpath)
│   └── incoming/                      → demo/test source files (vcf, cnv, cov, ...)
├── logs/                              → COYOTE3_LOGS_HOST_ROOT
└── mongo/
    ├── data/                          → COYOTE3_MONGO_DATA_HOST_ROOT
    ├── keyfile                        → COYOTE3_MONGO_KEYFILE_HOST_PATH (0600)
    └── backups/                       → COYOTE3_MONGO_BACKUP_HOST_ROOT
```

`COYOTE3_UID`/`COYOTE3_GID` and `MONGO_UID`/`MONGO_GID` were set to this
machine's own user (`1000:1000`, from `id -u`/`id -g`) rather than the
example defaults (`10001:10001`), purely so container-written files under
these host paths stay directly readable/manageable on this pilot box
without `chown`/`sudo`. **A real production host will very likely use
different UID/GID values** — re-derive them there with `id -u`/`id -g` for
whatever account owns the deployment, don't copy these numbers forward.

This machine has a single 98GB root filesystem (no separate `/data` or
`/srv` mount) — fine for a pilot, but real sizing (Mongo growth, report
archives, ingest staging, ZIP-archive uploads up to 20GB each) needs actual
capacity planning before real deployment.

## 6. Port conflict with a pre-existing stack on this machine

Bringing up the pilot's `mongo` container failed:

```text
Error response from daemon: failed to set up container networking:
driver failed programming external connectivity on endpoint
coyote3_prod-mongo-1: failed to bind host port 127.0.0.1:27017/tcp:
address already in use
```

`docker ps -a` showed this machine already runs an unrelated project
("omixia": `app_omixia`, `nginx_omixia`, `mongo_omixia`, `redis_omixia`,
up for hours before this session started) with its own MongoDB bound to
host port 27017. That stack was left completely untouched — the fix was
entirely on our side: removed the stuck `Created`-but-never-started
`coyote3_prod-mongo-1` container (`docker rm`), changed
`COYOTE3_MONGO_PORT=27018` in `.coyote3_env`, and re-ran `up -d mongo`.
Note this only remaps the *host* port; containers on
`coyote3-pilot-app-net` still reach Mongo at `mongo-app:27017`
internally, unaffected by the host-side remap.

**Lesson**: on a shared/dev machine, always check `docker ps -a` (and
`ss -tlnp`/`lsof -i` for non-Docker listeners) for conflicting pre-existing
services *before* assuming a port-bind failure means something is wrong
with the new stack's own config.

## 7. Bootstrapping RBAC/reference data: venv, and a replica-set discovery trap

`scripts/bootstrap_database.py` runs on the host, directly against MongoDB
("never starts Compose services" by design), so it needs backend
dependencies installed outside any container:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q
```

First run failed with `ServerSelectionTimeoutError`:

```text
Could not reach any servers in [('mongo-app', 27017)].
Replica set is configured with internal hostnames or IPs?
... error=AutoReconnect('mongo-app:27017: ... Temporary failure in name
resolution ...')
```

Connecting with the host-mapped seed address
(`127.0.0.1:27018&replicaSet=coyote3-rs`) isn't enough: PyMongo's replica-
set discovery (SDAM) reconnects using the member's *advertised* address
from the replica set config — `mongo-app:27017`, the Docker-network alias
set via `MONGO_REPLICA_MEMBER_HOST` during `mongo_init` — which the host
shell can't resolve since it isn't on `coyote3-pilot-app-net`. **Fix**:
drop `replicaSet=` and add `directConnection=true` to the URI for this
host-side maintenance run, which skips full topology discovery and talks
directly to the seed address:

```bash
export COYOTE3_MONGO_URI='mongodb://coyote3_app:<MONGO_APP_PASSWORD>@127.0.0.1:27018/?authSource=admin&directConnection=true'
export IDENTITY_MONGO_URI="$COYOTE3_MONGO_URI"
PYTHONPATH=. .venv/bin/python scripts/bootstrap_database.py \
  --db coyote3_stage --identity-db coyote3_identity_stage \
  --username admin --email <email> --password '<temp>' \
  --sys-admin-username sysadmin --sys-admin-email <different-email> \
  --sys-admin-password '<temp>' --with-demo-center
```

Also hit, in order: (1) the two accounts need **distinct** email addresses
— reused the same address first and the script correctly refused; (2)
remembered this only applies to *host-side maintenance scripts* — the
running application containers connect from inside
`coyote3-pilot-app-net`, where `mongo-app` resolves normally and the full
`replicaSet=coyote3-rs` URI in `.coyote3_env` is correct and unchanged.

**Lesson**: a replica-set URI that works for an interactive `mongosh`
one-shot command (§ earlier verification) isn't automatically the right
URI for a script that keeps a `MongoClient` around — first connection can
succeed on the seed address while subsequent operations still get routed
through SDAM's replica-set discovery.

**Credentials**: the generated temporary superuser/sys_admin passwords
were shared with the operator directly in-session and are intentionally
**not** written into this file or any other committed file. Both accounts
force a password change at first login.

## 8. Bringing up the full stack

```bash
bash scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d --build
```

Built and started cleanly on the first attempt (mongo already up from
Phase 3; `mongo_init` re-ran idempotently). All nine containers
(`mongo`, `redis`, `monitor`, `docs`, `api`, `worker`, `beat`, `frontend`,
`proxy`) came up healthy.

`scripts/center_preflight.sh`, run standalone (not through
`compose-with-version.sh`), failed on `COYOTE3_IMAGE_TAG` interpolation:

```text
error while interpolating services.api.image: required variable
COYOTE3_IMAGE_TAG is missing a value: Run scripts/compose-with-version.sh
to select the environment image tag
```

`center_preflight.sh` computes `COYOTE3_VERSION` itself but, unlike
`compose-with-version.sh`, never derives `COYOTE3_IMAGE_TAG` (the
`<version>-<env-suffix>` logic lives only in the wrapper). Worked once
exported manually to match what the wrapper actually used:

```bash
export COYOTE3_IMAGE_TAG='4.0.0-stage'   # api/version.py output + our stage suffix
bash scripts/center_preflight.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml
```

This looks like a genuine gap in the pre-release `api` branch's tooling
(two scripts, one derives the tag and the other doesn't) rather than
anything specific to our setup — noted here rather than patched, since
it's upstream tooling and out of scope for a pilot.

**Verification**: `/api/v1/health` returned `{"status":"ok"}`.
`POST /api/v1/auth/sessions` as the bootstrap superuser returned `201`
with a session cookie, the full expected permission set, and
`must_change_password: true`. This confirms the whole path — nginx →
api → identity DB — end to end. No browser was available in this
environment to click through the actual UI or see the forced
password-change screen render; that still needs a manual check.

## 9. LAN firewall blocking the pilot port

The stack passed every server-side check (`/api/v1/health`, login via
`curl`) but the browser on a separate device on the LAN got "127.0.0.1
refused to connect" (wrong host — see below) and then, after fixing that,
a silent timeout on `192.168.0.30:6801`. `sudo ufw status` showed an
active firewall allowing only `OpenSSH`, `Apache Full`, `Nginx Full`,
calico/vxlan traffic, and port `5000` — port `6801` was never opened, so
`ufw` silently dropped inbound connections to it from other machines
(loopback traffic on the server itself isn't filtered by these rules,
which is why `curl` from the server always worked). Fixed with:

```bash
sudo ufw allow from 192.168.0.0/24 to any port 6801 proto tcp comment 'Coyote3 pilot (internal LAN only)'
```

Scoped to the LAN subnet rather than "Anywhere" to match the
internal-LAN-only decision, unlike the existing `Nginx Full`/`Apache
Full` rules on this machine which are open to the internet. (The
"127.0.0.1 refused to connect" symptom before this was simply the
browser's own machine having nothing listening on its own loopback —
a reminder to always use the server's real LAN IP, not `127.0.0.1`,
from a different device.)

## 10. Real bug: broken asset serving through the nginx proxy

After the firewall fix, the browser could reach the server but showed a
blank page with `NS_ERROR_CORRUPTED_CONTENT` in the console for every JS
and CSS asset (Network tab showed them with `Type: html` instead of
`script`/`stylesheet`). `curl`-based diagnosis (see chat transcript for
the full step-by-step) traced this to a genuine bug in
`deploy/compose/nginx/render-config.sh`:

- The proxy's `location /` (frontend catch-all) sets a variable
  (`set $frontend_target "http://frontend:3000";`) and then does
  `proxy_pass $frontend_target/;` — note the trailing `/` written as
  literal text after the variable.
- nginx does **not** apply its usual "replace the matched location
  prefix with the proxy_pass URI" logic when the target is a variable —
  per nginx's documented behavior, any literal text following a variable
  in `proxy_pass` is used as-is, and the actual remainder of the request
  URI is discarded. So `location /` was proxying **every** request
  (`/assets/index-BmOZriqs.js`, `/assets/anything.css`, ...) to literally
  `http://frontend:3000/` — the SPA's `index.html` — regardless of what
  was actually requested. Browsers correctly refuse to execute HTML
  content served in response to a `<script type="module">` request.
- This only reproduces when `SCRIPT_NAME=''` (root-path deployment, no
  URL prefix). The script's other branch, used when `SCRIPT_NAME` is set
  (e.g. Lund's own `/coyote3_dev` prefix), already has the correct form
  (`proxy_pass $frontend_target;`, no trailing text) at its equivalent
  locations — which is almost certainly why this has never been caught
  upstream: their own deployments always set a prefix.
- **Fix**: removed the trailing `/` in the no-prefix branch's
  `location /` so it matches the already-correct prefixed branch. One
  line, `deploy/compose/nginx/render-config.sh`. Recorded in
  `docs/internal/fork_notes.md`'s divergence table — worth reporting
  upstream since it affects any center choosing a root-path deployment,
  not just us.

**A second, environment-specific finding while fixing this**: editing the
host file and expecting the running `proxy` container (which bind-mounts
`render-config.sh` read-only) to see the change immediately did not work
in this session — `docker exec coyote3_prod-proxy-1 grep ... render-config.sh`
showed *stale* content even after the host-side edit was confirmed saved.
`docker restart`/`docker ... up -d --force-recreate proxy` also both
failed with `permission denied`. Both point to this environment's Docker
access being a constrained/proxied Docker-outside-of-Docker setup, where
the assistant's shell and the real Docker daemon's bind-mount source may
not be perfectly in sync, and certain lifecycle operations (stop/restart)
are blocked outright. Worked around by patching the *running container's
already-rendered* `/etc/nginx/conf.d/default.conf` directly via
`docker exec` + `nginx -s reload` — sufficient to unblock this pilot
session, but **not a substitute for confirming the fix from a real,
unconstrained `docker compose up --build` later** (on real
server/cloud infrastructure, or from your own terminal on this machine
outside this constrained session). The committed source fix in
`render-config.sh` is correct and will regenerate the right config on any
normal rebuild — this caveat is only about verifying it *from within this
assistant session*.

## 11. Phase 6 — demo DNA ingest: wrong watch path, then a scoping surprise

**Wrong path first**: staged `generic_case_control.yaml` (renamed to
`coyote3.yaml`) plus its four sibling files under
`coyote_data/app-data/copied_sample_files/yaml/demo_dna/`, matching what
`api/config/paths.py`'s `INGEST_WATCH_DIR` looked like on a first read
(`/data/copied_sample_files/yaml`). Waited 8+ minutes with no `.done`
marker. The watcher's own log line gave it away —
`'watch_dir': '/data/coyote3_stage/copied_sample_files/yaml'` — an extra
`coyote3_stage` segment. `environment_storage_root()` in `api/config/paths.py`
namespaces all storage (`INGEST_WATCH_DIR`, `REPORTS_BASE_PATH`,
`INGEST_STAGING_DIR`) under `/data/coyote3_<env-short-name>/`, derived from
`ENV_NAME` (`staging` → `coyote3_stage`) — a detail the doc's example paths
(`/srv/coyote3-data/coyote3/incoming/...`) don't make obvious at a glance.
Moved the bundle to
`coyote_data/app-data/coyote3_stage/copied_sample_files/yaml/demo_dna/` and
it was picked up within one ~30s beat cycle:

```text
Sample demo_dna_sample ingested with unavailable expected files: biomarkers, transloc.
Required files passed validation; ingestion proceeded.
{'status': 'ok', ..., 'scanned': 1,
 'ingested': [{'sample_id': '6aa5486aed7b80bbc4392397', 'sample_name': 'demo_dna_sample'}],
 'failed': []}
```

The `biomarkers`/`transloc` warning is benign — those are ASP-declared
optional files our demo manifest doesn't provide; only files actually
declared in the manifest must succeed.

**Scoping surprise (correct behavior, not a bug)**: tried to confirm the
sample via `GET /api/v1/samples` using the `sysadmin` account (had to set
a permanent password first — its temporary one couldn't call any endpoint
until changed, `403 password_change_required`). Got back an empty list
despite the sample existing. Checking the login response explained why:
`sysadmin`'s role has `asp_ids: []`, `asp_groups: []`, and no
`sample:list:global`/`sample:view:global` permission — it's an
operational/system-configuration role, deliberately not scoped to see
clinical sample data. This is RBAC working as designed, not a bug;
verification of actual sample visibility needs the `admin` (superuser)
account instead, which only the operator holds the current password for
after the browser-driven password change in Phase 5.5.

## 12. Phase 6 — RNA demo ingest and the token-based API path

RNA demo bundle ingested cleanly on the first attempt (correct
environment-namespaced path already known from §11): `sample_id:
6aa55223ed7b80bbc43923eb`, no warnings. The fixture's `fusion_files:
../collections/all_collections_dummy/fusions.json` points outside
`demo_data/ingest/` into `demo_data/collections/`; rather than replicate
that relative layout under our watch directory, copied `fusions.json`
alongside the other three RNA files and pointed the manifest at it
directly (`fusion_files: fusions.json`) — ingest only cares that the path
resolves, not that it matches the repo's own layout.

**Token-based remote/API path**, exercised as a realistic stand-in for a
pipeline stage running on separate infrastructure:

```bash
# 1. Mint a short-lived credential (needs ingest.token:issue; sysadmin has it)
curl -s -b cookies.txt -X POST http://<host>/api/v1/admin/ingest-tokens \
  -H "Content-Type: application/json" -H "X-CSRF-Token: <csrf>" \
  -d '{"expires_hours": 2}'
# -> {"token": "...", "environment": "stage", "scope": "sample-ingest", ...}

# 2. Submit yaml_file + a ZIP of the declared files, authenticated by the
#    token header instead of a session cookie
curl -s -X POST http://<host>/api/v1/internal/ingest/sample-bundle/upload \
  -H "X-Coyote-Ingest-Token: <token>" \
  -F "yaml_file=@coyote3.yaml;type=application/x-yaml" \
  -F "data_archive=@data_archive.zip;type=application/zip"
```

Used a renamed copy of the DNA demo bundle (`demo_dna_sample_api`) to
avoid colliding with the file-drop sample. Response: `HTTP 200`,
synchronous result `{"snvs": 72, "cnvs": 7, "cov": 1}` written,
`sample_id: 6aa55becf3b9f3668d3d0a3d`. `zip` wasn't installed on this
host — built the archive with Python's `zipfile` module instead.

All three ingest transports (file-drop DNA, file-drop RNA, token+ZIP API
upload) are now validated end-to-end. Phase 6 is complete.

## 13. Phase 7 — a hard environmental limit: this session cannot deploy image rebuilds

Edited `api/config/center/contact.toml` with placeholder pilot values (was
SMD Lund's real department name and staff `@skane.se` emails — expected,
since this file is meant to be fully replaced per center). Unlike
`render-config.sh` (§10), this file is **baked into the API image at
build time** (`docker/Dockerfile`: `COPY api/ ./api/`) and loaded once
into a module-level Python constant at process start
(`api/config/runtime_settings.py`) — there is no live-reload path, and
nothing analogous to `nginx -s reload`.

`docker compose ... up -d --build api worker beat` **did** successfully
build a new image (`coyote3-api:4.0.0-stage`, id `997b1e8b66cb`) containing
the updated file — confirmed by comparing it against the running
container's still-pinned old image id (`2ebf6c3d1c44...`, via
`docker inspect --format '{{.Image}}'`). But recreating the container to
actually run the new image failed at the same `up`'s internal "stop the
old container" step, with the identical `permission denied` seen with
`proxy` in §10.

**This time it was worth confirming the restriction is universal, not
container-specific**: started a disposable `alpine` container fresh in
this session and tried to `stop`/`kill` it — same `permission denied`.
So this is a hard, blanket policy of this assistant session's Docker
access (almost certainly a constrained/proxied Docker-outside-of-Docker
setup, consistent with the earlier `restart`/`force-recreate` failures)
that blocks stopping or killing **any** container, regardless of who
started it or how. `docker build`, `create`, `exec`, `rm` (on already-
stopped containers), and read-only inspection all work fine — only the
stop/kill/restart family is blocked.

**Practical consequence for this pilot and any future session like it**:
any change requiring an image rebuild (center config under `api/config/`,
frontend branding/theme, anything else baked in at `COPY` time) can be
authored and image-built from here, but **cannot be deployed or visually
verified without a container recreate run from an unconstrained
terminal** — i.e. by you, not by the assistant, in this kind of session.
This is distinct from KI-001 (a real product bug); this is purely an
operating constraint of the assistant's environment. Source-level changes
in this category are still correct and ready — they just need your
`docker compose ... up -d --build` (or equivalent) to actually take
effect, the same way the git pushes earlier in this session did.

**Update**: the "permission denied" turned out to be a real, host-wide bug
independent of the assistant's sandbox — it reproduced identically from
the operator's own terminal (see §16). It's now fixed at the host level;
`docker stop`/`kill`/`restart` work normally again, from any session.

## 14. Creating a custom RBAC role — the `form_data` wrapper

Created a pilot-only role (`pilot_clinical_reviewer`, level 80, ten
clinical-review permissions, no admin access) via `POST /api/v1/roles` to
exercise the RBAC customization mechanism. First two attempts both
returned this despite sending complete, valid field values:

```json
{"error": "Invalid role payload: 5 validation errors for RolesDoc\nrole_id\n  Value error, role_id/name is required ..."}
```

Ruled out shell/quoting issues (`--data-binary @file.json`, confirmed
with `curl -v` that a 539-byte body really was sent). The actual cause:
`RoleManagementService.create_role` (`api/application/accounts/roles.py`)
reads `payload.get("form_data", {})` — **the admin resource-form API
contract expects every field wrapped under a `form_data` key**, not flat
top-level JSON:

```json
{"form_data": {"name": "...", "label": "...", "color": "#2563eb", "level": 80, "permissions": [...]}}
```

Once wrapped correctly: `HTTP 201`, verified present via
`GET /api/v1/roles?q=pilot`. This `form_data` envelope is presumably
shared by the whole generic admin-resource CRUD pattern (ASP/ASPC/ISGL
likely use the same shape, per `AdminResourcePages.tsx`/`resource-form.tsx`
on the frontend side) — worth remembering for any future direct-API admin
scripting rather than rediscovering it each time.

## 15. What's still genuinely open before a real production/cloud rollout

- Real hosting target (this pilot proved the stack works; it did not pick
  the eventual on-prem or cloud target).
- Real organization name/contacts (`api/config/center/contact.toml`),
  branding assets, and RBAC role set — this pilot only exercises the
  mechanism with placeholder values, not real content.
- LDAP integration (deferred; local accounts only so far).
- SMTP relay (not configured; notifications/password-reset degrade
  gracefully without it, but the stack still starts).
- Knowledgebase licensing, especially OncoKB (not decided).
- The BAM/CRAM alignment-file share (§4) — a separate project from
  everything above.
- UID/GID, storage paths, and `PUBLIC_BASE_URL`/TLS must all be
  re-derived for whatever machine actually hosts the real deployment —
  none of this pilot's values should be copied forward unchanged.
- Confirm the `render-config.sh` nginx fix (§10) survives a real, full
  `docker compose ... up -d --build` — now verified on this host after the
  §16 daemon migration (proxy container rebuilt and recreated cleanly).
  Still worth reporting upstream to SMD Lund.
- Firewall rule for whatever port the real deployment uses must be added
  deliberately (§9) — nothing about Coyote3 itself opens firewall ports.
- If the real deployment host also turns out to run Docker as a **snap**
  package (check with `docker info | grep -i "Docker Root Dir"` — a path
  under `/var/snap/docker/...` is the tell), pre-empt §16's entire problem
  by installing `docker-ce` from Docker's official apt repo instead, before
  bringing up any stack.

## 16. Root cause and fix: `docker stop`/`kill`/`restart` blocked host-wide

**What was originally suspected**: §13 assumed the "permission denied" on
`docker stop`/`kill`/`restart` was a restriction specific to the
assistant's sandboxed Docker access (a socket proxy or similar). That
assumption was wrong, and worth recording because the disproof is
instructive: the operator reproduced the identical error from their own,
completely unconstrained terminal (`docker compose down` on the unrelated
pre-existing `omixia` stack failing the same way). That ruled out
"assistant sandbox" immediately — this was a real, host-wide bug affecting
every Docker client on the machine, ours and everyone else's.

**Root cause, found via the kernel audit log**
(`journalctl -k | grep -i apparmor`):

```
apparmor="DENIED" operation="signal" class="signal" profile="docker-default"
requested_mask="receive" denied_mask="receive" signal=term
peer="snap.docker.dockerd"
```

This machine had **two Docker daemons installed simultaneously**: the
`docker` *snap* package (`snap.docker.dockerd.service`, data-root
`/var/snap/docker/common/var-lib-docker`) and the standard `docker-ce` apt
package (`docker.service`/`docker.socket`, data-root `/var/lib/docker`,
already installed — no fresh install was ever needed). Both were racing
for the same `/run/docker.sock`; the snap one had won that race since
boot, so every `docker` command was actually being served by it.

The snap package runs under strict AppArmor confinement
(`snap.docker.dockerd`). Every container gets the standard `docker-default`
AppArmor profile, but that profile — generated by upstream Docker,
unaware it might ever run under a snap-confined daemon — has no rule
permitting it to **receive** a signal from a peer labeled
`snap.docker.dockerd`. The kernel LSM denies the SIGTERM/SIGKILL outright,
regardless of Linux capabilities (the daemon runs as root with `CAP_KILL`
— capabilities and AppArmor mediation are independent, and AppArmor said
no). This is why `sudo kill -9 <pid>` always worked as a manual escape
hatch: an interactive shell is `unconfined` in AppArmor terms, and
`docker-default` does have a rule permitting signals from `unconfined`
peers — just not from `snap.docker.dockerd`.

One early, misleading data point: `docker info` reported
`Operating System: Ubuntu Core 24`, which looked like this might be an
immutable, snap-only OS where no other fix was possible. That was a red
herring — `/etc/os-release` confirmed a completely normal Ubuntu 24.04.4
LTS Server (ext4 root, full `apt`/`dpkg`). The snap-packaged `dockerd`
simply reports its own confinement base's OS string, not the real host's.

**The fix**: since `docker-ce` was already installed and enabled, no
package installation was needed — only a cutover:

1. Stopped the pre-existing `omixia` stack (`docker compose down`; where
   containers themselves wouldn't stop due to this same bug, force-killed
   their PIDs directly with `sudo kill -9`, then `down` succeeded against
   the already-exited containers).
2. `sudo systemctl stop snap.docker.dockerd.service` +
   `sudo systemctl disable snap.docker.dockerd.service` (prevents it
   reclaiming the socket on a future reboot).
3. `sudo systemctl restart docker.socket docker.service` — confirmed via
   `docker info` that `Docker Root Dir` now reads `/var/lib/docker` and
   `Operating System` reads the real Ubuntu string.
4. **Migrated `omixia`'s three Docker-managed named volumes**
   (`backend_omixia_mongo_data`, `backend_omixia_redis_data`,
   `backend_omixia_reports`) from the snap data-root to the `docker-ce`
   data-root with `sudo mv` (same filesystem, so this was instant with no
   extra disk needed) — Coyote3 itself needed no data migration, since all
   its persistent storage was already on host bind mounts (§5), never in
   a Docker-managed volume.
5. Re-registered the moved volumes with `docker volume create <name>` for
   each — moving the raw directories alone wasn't enough, because modern
   Docker's `local` driver tracks known volumes in an internal metadata
   store, not by scanning the filesystem. `docker volume create` against
   a path that already has data reuses it in place rather than wiping it;
   verified file contents were unchanged before and after.
6. Recreated the `coyote3-pilot-app-net` external network (networks
   aren't shared between daemons either), then brought `omixia` back up
   (`docker compose up -d`; confirmed with `mongosh --eval
   "db.adminCommand('ping')"` that the migrated data was actually
   readable) and Coyote3 back up (`compose-with-version.sh ... up -d
   --build`).
7. Hit one more artifact of the old bug during this step: Coyote3's own
   `mongo` container's **process had survived as an orphan** on the host
   (`containerd-shim` processes are deliberately designed to survive a
   daemon stop, so the container itself never truly died even though
   `docker ps` no longer listed it) and was still holding the lock file
   on the bind-mounted `/data/db`, causing the freshly-recreated `mongo`
   container to crash-loop with `DBPathInUse`. Found it with
   `ps aux | grep mongod` (a `mongod --replSet coyote3-rs ...` process
   running since the original Phase 3 bring-up) and `sudo kill -9`'d it
   directly; the new container then started cleanly.
8. Verified the actual fix: `docker restart coyote3_prod-monitor-1`
   succeeded (exit code 0) — the exact operation that failed throughout
   §10/§13. Confirmed the full app still serves correctly
   (`GET /api/v1/health` → `{"status":"ok"}` through the real nginx proxy)
   and that `omixia` was undisturbed (`curl` to its port still 200).

**Why this shouldn't recur on a real production host**: installing Docker
via `snap install docker` is an unusual choice for a server — most Linux
server setups use `docker-ce` from the official apt/yum repo, which isn't
snap-confined and doesn't have this AppArmor gap at all. This was purely a
quirk of how Docker happened to be installed on this specific pilot
machine. Added a check for it to the §15 pre-production checklist.

**Update**: `sudo snap remove docker` was run once the migration above was
confirmed stable — the snap is now fully gone (snapd took an automatic
data snapshot before removing it, in case it's ever needed again). Re-ran
the full verification after removal: `docker info` still reports
`/var/lib/docker`/real Ubuntu 24.04, and both `coyote3_prod-*` and
`omixia` containers stayed up and healthy throughout (removal only
touches the already-inactive snap, not the running `docker-ce` daemon).
This host now has exactly one Docker installation, eliminating the
ambiguity permanently. A dedicated standalone write-up of this whole
issue lives in `docs/docker_issue.md`.

## Appendix: full session command log

Every shell command actually executed in this session, in order. Read-only
exploration (`Read`, plain `grep`/`ls`/`cat` used only to inspect code) is
included where it directly informed a decision; pure file reads of
documentation are omitted for length — see the narrative sections above for
what was read. File writes/edits are listed by path at the end of each
group rather than reproduced in full (their content is in the repo).

### 1. Initial repo survey

```bash
find /home/saile/develop/coyote3 -maxdepth 1 -type f -o -maxdepth 1 -type d | sort
ls -la api/config/center/ && ls api/config/bootstrap/ && ls deploy/compose/ && ls migration_scripts/
git remote -v && git branch -a && docker --version && docker compose version
```

### 2. Fork and remote setup

```bash
gh --version; gh auth status                       # gh not installed
git ls-remote https://github.com/zliasailz/coyote3.git | head -20

git remote rename origin upstream
git remote add origin https://github.com/zliasailz/coyote3.git
git fetch origin --prune
git fetch upstream --prune
git remote -v

git checkout -b center/main origin/master          # wrong base, fixed in §4 below
git push -u origin center/main                     # failed: no credentials in this shell
git status

git config --get credential.helper                 # empty
ls -la ~/.ssh/                                      # id_ed25519 present but...
ssh -T git@github.com -o BatchMode=yes              # ...not registered with GitHub
```

Files: created `docs/internal/fork_notes.md` (later rewritten, see §4).

### 3. Confirming the push landed (after user pushed manually)

```bash
git status; git log --oneline -3; git branch -vv | grep center
git ls-remote origin center/main
```

### 4. Discovering and fixing the master/api architecture mixup

```bash
# This is what surfaced the problem: api/ didn't exist on center/main
grep -rn "BAM_MONGO_URI|bam_service|BamService|GENS|IGV" docs/architecture/mongodb_topology.md
find api -iname "*bam*"                            # error: api: No such file or directory
pwd; ls                                             # showed coyote/, config.py, wsgi.py — old Flask app

git log --oneline -5 upstream/master
git merge-base upstream/master upstream/api
git log --oneline upstream/master..upstream/api | wc -l    # 241
git log --oneline upstream/api..upstream/master | wc -l    # 0

git fetch upstream api --prune
git reset --hard upstream/api                       # center/main now on api's tip
git status --short; ls | head -20                   # confirms api/, frontend/, AGENTS.md back

mkdir -p docs/internal
git add docs/internal/fork_notes.md
git commit -m "docs: add fork notes tracking upstream sync on api-based center/main"
git push --force-with-lease origin center/main       # failed: no credentials again
```

Files: rewrote `docs/internal/fork_notes.md` for the corrected base.

### 5. Deployment/ingest research (read-only)

```bash
ls deploy/compose/ deploy/env/ deploy/gunicorn/
grep -rln "ingest" api/interfaces/http/
find api -path "*ingest*" -name "*.py" | grep -v test
grep -n "router|@router|post|upload|manifest|token" api/interfaces/http/operations/internal.py | head -60
grep -n "ingest.token|issue_audited_ingest_token" api/interfaces/http/admin/operations.py
grep -rn "def require_sample_ingest_access" api/
```

Plus `Read` of: `docker-compose.yml`, `example.env`,
`example.mongo-local.env`, `docker-compose.mongo.yml`,
`docker-compose.storage.example.yml`, `docker-compose.mongo-backup.yml`,
`mongodb_topology.md`, `api/tasks/ingest.py`, `docs/api/sample_yaml.md`,
`upload_archive.py`, `ingest_tokens.py`, `tokens.py`, `access.py` (lines
555–620) — all summarized in §3–4 above.

### 6. First environment file and integration plan doc

```bash
test -f .coyote3_env && echo EXISTS || echo OK_TO_CREATE
openssl rand -hex 32    # x3: SECRET_KEY, INTERNAL_API_TOKEN, PASSWORD_TOKEN_SALT
openssl rand -hex 24    # REDIS_PASSWORD (wrong length, fixed in §8), MONGO_ROOT_PASSWORD, MONGO_APP_PASSWORD
id -u; id -g             # 1000, 1000
git check-ignore -v .coyote3_env    # confirmed gitignored
```

Files: created `.coyote3_env` (gitignored), `docs/internal/deployment_integration_plan.md`.

### 7. Pilot storage layout and phase-plan docs

```bash
df -h / /home /data /srv                            # single 98GB filesystem, 70GB free
grep -n "INGEST_WATCH_DIR|DATA_ROOT|/data" api/config/paths.py
hostname; hostname -I | awk '{print $1}'             # saile, 192.168.0.30

mkdir -p /home/saile/develop/coyote_data/app-data/copied_sample_files/yaml
mkdir -p /home/saile/develop/coyote_data/app-data/incoming
mkdir -p /home/saile/develop/coyote_data/logs
mkdir -p /home/saile/develop/coyote_data/mongo/{data,backups}
touch /home/saile/develop/coyote_data/mongo/keyfile
openssl rand -base64 756 > /home/saile/develop/coyote_data/mongo/keyfile
chmod 600 /home/saile/develop/coyote_data/mongo/keyfile
find /home/saile/develop/coyote_data -maxdepth 3 | sort
```

Files: created `.claude.plan.md`, `docs/deployment_notes_saile.md`; edited
`.coyote3_env` (pilot paths, `COYOTE3_UID/GID=1000`,
`PUBLIC_BASE_URL=http://192.168.0.30:6801`).

### 8. Env validation fixes (before starting anything)

```bash
git status --short; git branch --show-current
cat scripts/validate_env_secrets.sh | head -60
bash scripts/validate_env_secrets.sh --env-file .coyote3_env     # failed: REDIS_PASSWORD too short
sed -n '60,120p' scripts/validate_env_secrets.sh
openssl rand -hex 32                                              # correct-length REDIS_PASSWORD
bash scripts/validate_env_secrets.sh --env-file .coyote3_env     # passed

docker network inspect coyote3-pilot-app-net || docker network create coyote3-pilot-app-net
docker network ls | grep coyote3

# ENV_NAME=validation would have hard-failed compose-with-version.sh — caught by reading it:
python3 api/version.py                                            # 4.0.0
bash scripts/validate_env_secrets.sh --env-file .coyote3_env     # re-passed after ENV_NAME=staging fix
```

Files: edited `.coyote3_env` (`REDIS_PASSWORD`, `ENV_NAME=staging` +
matching DB names), `docs/deployment_notes_saile.md`, `.claude.plan.md`.

### 9. Phase 3 — bringing up MongoDB

```bash
./scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d mongo                        # Permission denied (script not +x)

bash scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d mongo                        # port 27017 already in use

ss -tlnp | grep 27017
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'   # found unrelated "omixia" stack
ss -tlnp | grep -E ':6801|:27018'                     # both free
docker rm coyote3_prod-mongo-1                        # remove the stuck, never-started container

# edited .coyote3_env: COYOTE3_MONGO_PORT 27017 -> 27018

bash scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d mongo                        # succeeded

docker inspect --format '{{.State.Health.Status}}' coyote3_prod-mongo-1   # polled until "healthy"
docker logs coyote3_prod-mongo-1 --tail 30

bash scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo run --rm mongo_init                # replica set "coyote3-rs" initiated

docker exec coyote3_prod-mongo-1 mongosh --quiet --host 127.0.0.1 \
  --username coyote3_app --password '<MONGO_APP_PASSWORD>' \
  --authenticationDatabase admin --eval 'db.adminCommand({ping:1})'   # { ok: 1 }
docker ps --filter "name=coyote3_prod" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Files: edited `.coyote3_env` (Mongo port), `.claude.plan.md`,
`docs/deployment_notes_saile.md` (this appendix).

### 10. Phase 4 — bootstrapping RBAC and reference data

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

PYTHONPATH=. .venv/bin/python scripts/bootstrap_database.py --help

openssl rand -base64 18    # x2: temporary superuser + sys_admin passwords

# First attempt: replicaSet=coyote3-rs against the host-mapped port — failed
# (ServerSelectionTimeoutError, mongo-app unresolvable from the host).
# Second attempt: same emails for both accounts — failed ("Use distinct
# email addresses for the two bootstrap accounts").
# Third attempt, corrected (directConnection, distinct emails):
export COYOTE3_MONGO_URI='mongodb://coyote3_app:<MONGO_APP_PASSWORD>@127.0.0.1:27018/?authSource=admin&directConnection=true'
export IDENTITY_MONGO_URI="$COYOTE3_MONGO_URI"
PYTHONPATH=. .venv/bin/python scripts/bootstrap_database.py \
  --db coyote3_stage \
  --identity-db coyote3_identity_stage \
  --username admin \
  --email <email> \
  --password '<generated>' \
  --sys-admin-username sysadmin \
  --sys-admin-email <different-email> \
  --sys-admin-password '<generated>' \
  --with-demo-center
```

Files: created `.venv/` (local, gitignored, not committed — same as
`node_modules/`).

### 11. Phase 5 — bringing up the full application stack

```bash
bash scripts/compose-with-version.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml \
  --profile mongo up -d --build

docker ps --filter "name=coyote3_prod" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:6801/api/v1/health
curl -s http://127.0.0.1:6801/api/v1/health

# center_preflight.sh needs COYOTE3_IMAGE_TAG exported manually (see §8)
export COYOTE3_IMAGE_TAG='4.0.0-stage'
bash scripts/center_preflight.sh --env-file .coyote3_env \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.mongo.yml

# Login verification at the API level (no browser available in this environment)
curl -s -i -X POST http://127.0.0.1:6801/api/v1/auth/sessions \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<temp>","provider":"local"}'
```

### All files created or edited this session

- `docs/internal/fork_notes.md` (created, then rewritten after the
  master/api fix)
- `docs/internal/deployment_integration_plan.md` (created)
- `.claude.plan.md` (created, updated after each phase)
- `docs/deployment_notes_saile.md` (this file; created, updated throughout)
- `.coyote3_env` (created, gitignored, edited repeatedly — never committed)
- `/home/saile/develop/coyote_data/**` (directory tree + Mongo keyfile,
  outside the repo entirely)

Current git state: on branch `center/main`, three files untracked
(`.claude.plan.md`, `docs/deployment_notes_saile.md`,
`docs/internal/deployment_integration_plan.md`) — not committed yet,
pending your go-ahead.
