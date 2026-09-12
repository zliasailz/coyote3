# Known Issues — Upstream Bugs Found During Our Deployment Work

Bugs discovered in the `api` branch (SMD Lund's upstream) while standing up
our own deployment, tracked here so they aren't silently lost across
rebuilds, upstream syncs, or a future production/cloud deployment. Each
entry states whether the fix is currently only applied locally in a running
environment, or committed to `center/main`. **Before any production
deployment, re-check every entry below is still needed** — an upstream sync
may have fixed it independently, in which case remove the entry and drop
our local patch during the merge (see `fork_notes.md`'s sync process).

---

## KI-001: Root-path nginx deployments silently serve `index.html` for every static asset

- **Status**: Fixed in `center/main` (commit pending — see below). **Not yet
  reported upstream to SMD Lund.**
- **Severity**: Critical for any deployment using `SCRIPT_NAME=''` (no URL
  path prefix). The entire web UI is unusable — every JS/CSS/image request
  returns the SPA shell instead of itself, so the page renders blank and
  browsers report a content-type/corruption error.
- **Does not affect**: Deployments that set a non-empty `SCRIPT_NAME` (e.g.
  SMD Lund's own `/coyote3_dev`, `/coyote3` convention) — that code path was
  already correct. This is almost certainly why the bug has gone unnoticed
  upstream: a root-path deployment is untested territory there.
- **File**: `deploy/compose/nginx/render-config.sh`

### Symptom

Loading the app in a browser shows a blank page. DevTools Network tab shows
every `/assets/*.js` and `/assets/*.css` request returning HTTP 200 but with
`Type: html` instead of `script`/`stylesheet`, and Firefox reports
`NS_ERROR_CORRUPTED_CONTENT` (Chrome: a MIME-type/`strict-mime` refusal to
execute). `curl` confirms every such request returns the same
`Content-Type: text/html`, same byte count, and same `ETag` as `GET /` —
i.e. literally the index page, not the requested file. This reproduces
identically regardless of which specific asset path is requested, on a
fresh connection, with or without keep-alive — it is fully deterministic,
not a caching or race condition.

The API (`/api/...`) and docs (`/docs-site/...`) continued to work
normally; only the frontend's static-asset catch-all was affected.

### Root cause

The generated nginx config (rendered by `render-config.sh` at container
start) has two branches depending on whether `SCRIPT_NAME` is set. In the
**no-`SCRIPT_NAME` branch** (the common/simple case — a deployment with no
URL path prefix), the frontend catch-all location was:

```nginx
set $frontend_target "http://frontend:3000";
...
location / {
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass $frontend_target/;   # <-- bug: trailing "/" after a variable
}
```

nginx's `proxy_pass` URI-substitution behavior (replacing the matched
`location` prefix with the directive's URI, so `/assets/foo.js` under
`location /` becomes `/assets/foo.js` appended to the backend) **only
applies when the entire `proxy_pass` target is a static, literal string
that nginx can parse at config-load time.** As soon as any part of the
target is a variable — here, `$frontend_target` — nginx cannot determine
where the "location-prefix" portion ends and the "URI" portion begins. Per
nginx's documented behavior, any literal text written after such a
variable is used exactly as written, and **the actual incoming request URI
beyond the matched location is discarded entirely.** So this directive
proxied literally every request under `location /` — `/`, `/assets/x.js`,
`/assets/y.css`, anything — to the fixed string `http://frontend:3000/`,
which is the SPA's `index.html`.

The already-correct `SCRIPT_NAME`-prefixed branch's equivalent locations
(`location ${script_name}/` and the outer catch-all `location /`) use
`proxy_pass $frontend_target;` — **no trailing text after the variable** —
which is the documented safe form: "if `proxy_pass` is specified without a
URI, the request URI is passed to the server in the same form as sent by
the client." That form correctly forwards the full path.

### Fix

One-line change in the no-`SCRIPT_NAME` branch of
`deploy/compose/nginx/render-config.sh`, matching the already-correct
prefixed branch:

```diff
     location / {
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
-        proxy_pass $frontend_target/;
+        proxy_pass $frontend_target;
     }
```

### Reproduction

```bash
# With the buggy config rendered and nginx reloaded:
curl -sD - -o /dev/null http://<host>:<port>/assets/<any-real-asset>.js
# Observe: Content-Type: text/html, Content-Length matches GET /, not the
# actual JS file's size.
```

### Verification after the fix

```bash
for path in / /assets/<hashed-index>.js /assets/<hashed>.css /logo.png; do
  curl -s -o /dev/null -w "%{content_type} (%{size_download} bytes)\n" \
    http://<host>:<port>$path
done
# Every path should report its own correct content-type and byte size,
# not identical values across all of them.
```

### Deployment status of this fix — read before going to production

- The source fix **is** committed in `deploy/compose/nginx/render-config.sh`
  on `center/main`.
- Initially verified only by live-patching the *already-running* proxy
  container's rendered config and reloading nginx, not a full rebuild —
  the session's Docker access could not recreate containers at the time
  (see `docs/internal/known_issues.md` history / `deployment_notes_saile.md`
  §13). That constraint turned out to be a real, host-wide Docker bug
  (snap-packaged Docker's AppArmor profile blocking container stop/kill —
  full root cause and fix in `deployment_notes_saile.md` §16), not specific
  to this fix or this app.
- **Now fully verified via a real `docker compose ... up -d --build`** after
  that host-level Docker issue was fixed: the proxy container was rebuilt
  and recreated from scratch (not live-patched), and the running app was
  reconfirmed serving correctly end-to-end. This fix is confirmed durable
  across a normal rebuild/redeploy cycle, not just a live patch.
- **Recommend reporting this upstream** to SMD Lund
  (`SMD-Bioinformatics-Lund/coyote3`) — it will affect any other adopting
  center that chooses a root-path deployment, not just us.

---

<!-- Add future entries above this line, most recent first, using the same
     Status/Severity/File/Symptom/Root cause/Fix/Verification/Deployment
     status structure. -->
