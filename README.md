# artifacts.latha.org

Build artifact clearing house for nandi's apps — one Cloudflare Worker + R2
bucket, shared across every registered app instead of one Worker per repo.

Originally built sleek-only as `proxy.latha.org` (see
[codegod100/sleek](https://github.com/codegod100/sleek)'s git history,
`cloudflare/proxy-latha-org/`) — moved out to its own repo and generalized
into a multi-app registry (`worker.js`'s `APPS` object) so adding a second
app doesn't mean forking the whole Worker.

```
push to <app's tangled.org repo> (main or a tag)
  → Tangled fires a `push` webhook  →  https://artifacts.latha.org/webhook/<app>
  → Worker verifies HMAC, triggers a BuildBuddy remote run
  → BuildBuddy executor: buck2 build <app's targets>, PUTs finished files
    back to https://artifacts.latha.org/upload/<app>/<sha>/<file>
  → Worker stores them in R2, serves them at:
      https://artifacts.latha.org/artifacts/<app>/<sha>/<file>
      https://artifacts.latha.org/artifacts/<app>/latest/<file>   (newest)
  → tag pushes additionally publish to that app's tangled.org repo as
    sh.tangled.repo.artifact release records (visible under a tag's
    "Artifacts" section)
```

No npm/wrangler dependency to *deploy* — `worker.js` is a plain ES module
Worker, deployed via the raw Cloudflare API (`deploy.sh`, just curl + jq).
`wrangler` (via `npx`) is handy for one-off `r2 object put`s when
hand-publishing something outside the webhook→build→upload flow (e.g. a
flatpak repo tree) — no Cloudflare API token needed for that, just
`wrangler login` (OAuth).

## Adding an app

Add an entry to `worker.js`'s `APPS` object:

```js
const APPS = {
  sleek: {
    cloneUrl: "https://tangled.org/nandi.uk/sleek",
    repoDid: "did:plc:eimwo4adqwppiiweleayixez", // that repo's own DID, not the owner's
    targets: [
      { buckTarget: "//:sleek-android-apk", filename: "sleek.apk", contentType: "application/vnd.android.package-archive", tagOnly: false },
      { buckTarget: "//:sleek-host", filename: "sleek-x86_64-linux", contentType: "application/octet-stream", tagOnly: true },
    ],
  },
  // your-new-app: { ... },
};
```

- `repoDid` is the app repo's **own** auto-assigned DID — run
  `git remote -v` on a checkout and read it off the `tangled` remote
  (`git@tangled.org:did:plc:...`), not the owner's personal DID.
- `targets` are buck2 targets built via BuildBuddy remote execution — the
  app's own repo needs the same `platforms/defs.bzl`-style RBE image setup
  sleek has (see that repo for reference). `tagOnly: true` skips building
  that target on plain branch pushes.
- Redeploy (`./deploy.sh`), then in that app's Tangled repo → **Settings →
  Hooks → new webhook**:
  - Payload URL: `https://artifacts.latha.org/webhook/<app-slug>`
  - Secret: the shared `TANGLED_WEBHOOK_SECRET`
  - Events: `push`

Everything else — routing, R2 storage, the atproto OAuth publisher, the
index page — is already app-agnostic; nothing else in this file needs
touching for a new app.

## One-time setup

1. Cloudflare: an API token with Workers Scripts, R2, and Zone(DNS) edit on
   the account that owns the `latha.org` zone, plus the account ID. (A
   `wrangler login` OAuth token works here too — see `deploy.sh`'s header
   comment.)
2. BuildBuddy: an org API key from https://app.buildbuddy.io/ → Settings.
3. Pick a `TANGLED_WEBHOOK_SECRET` and `UPLOAD_TOKEN` (random strings —
   `openssl rand -hex 32`). These never touch git; they're pushed straight
   into the Worker as encrypted secret bindings by `deploy.sh`.

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export TANGLED_WEBHOOK_SECRET=...   # openssl rand -hex 32
export BUILDBUDDY_API_KEY=...
export UPLOAD_TOKEN=...             # openssl rand -hex 32
./deploy.sh
```

4. On each app's tangled.org repo: **Settings → Hooks → new webhook** (see
   "Adding an app" above for the payload URL shape).
5. Once, visit `https://artifacts.latha.org/oauth/login` and approve —
   authorizes the Worker to publish `sh.tangled.repo.artifact` release
   records as nandi's own atproto identity. Shared across every app; only
   needs doing once total, not per app.

That's the whole trust chain — Tangled only knows the Worker's HMAC secret,
BuildBuddy only knows its own API key (held by the Worker, never any app's
repo), and the remote build only knows a single-purpose upload bearer token
good for PUTting artifacts back.

## Re-deploying

`./deploy.sh` is idempotent — re-run it any time `worker.js` changes or a
secret rotates (pass the new value as the same env var; omit env vars for
secrets you're not rotating and the existing bound value carries forward
unchanged).

## Publishing a flatpak repo by hand

Not part of the webhook→build→upload flow (flatpak repos are OSTree trees,
not single build outputs) — built + pushed manually per app, whenever its
bundle changes:

```bash
# From a checked-out .flatpak bundle:
ostree init --repo=repo --mode=archive-z2   # first time only
flatpak build-import-bundle repo path/to/app.flatpak
flatpak build-update-repo repo

# Upload the whole tree under <app>/repo/ via wrangler (OAuth, no API token needed):
npx --yes wrangler login
find repo -type f | while IFS= read -r f; do
  npx --yes wrangler r2 object put "proxy-latha-org-artifacts/<app>/repo/${f#repo/}" --file "$f" --remote
done
```

Then author `<app-id>.flatpakref` with
`Url=https://artifacts.latha.org/artifacts/<app>/repo/` and upload it
alongside at top-level key `<app>/<app-id>.flatpakref` — the index page
(`GET /`) auto-detects it (probes for `<app>/repo/config` +
`<app>/*.flatpakref`) and shows the one-line install command.

## Known gaps

- No automated test suite yet in this repo (the old sleek-only
  `cloudflare/proxy-latha-org/test_worker.mjs` was written against the
  single-app routes and hasn't been ported/generalized).
- `contentTypeForArtifact()` still guesses content type from filename
  extension rather than using each target's own `contentType` field end to
  end — fine for the handful of artifact kinds actually published so far,
  worth tightening if more content types show up.
