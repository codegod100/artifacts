#!/usr/bin/env bash
# Deploy artifacts.latha.org via the raw Cloudflare API (no wrangler/node
# needed to *deploy*, though `wrangler` is handy for one-off R2 object
# puts — see README.md).
#
# Creates/updates:
#   - R2 bucket "proxy-latha-org-artifacts" (kept from this Worker's
#     previous single-app life as proxy.latha.org — Cloudflare has no
#     bucket rename, and it already holds the atproto OAuth session, not
#     worth losing for a cosmetic rename)
#   - Worker script "artifacts" (module worker, worker.js), with bindings:
#     ARTIFACTS (r2_bucket) + 3 secret_text bindings
#   - Custom domain route artifacts.latha.org -> that worker (needs the
#     latha.org zone already on this Cloudflare account)
#
# Required env:
#   CLOUDFLARE_API_TOKEN   Workers Scripts:Edit, Workers Routes:Edit (or
#                          Account:Workers R2 Storage:Edit + Zone:Edit for
#                          DNS on latha.org) — a `wrangler login` OAuth
#                          token (see ~/.config/.wrangler/config/default.toml
#                          -> oauth_token) works fine as this value too.
#   CLOUDFLARE_ACCOUNT_ID  (optional — derived from the token via
#                          GET /accounts if unset)
#
# Optional env (only needed to *set/rotate* a value — see below):
#   TANGLED_WEBHOOK_SECRET Paste the same value into every registered app's
#                          Tangled Settings -> Hooks -> Secret.
#   BUILDBUDDY_API_KEY     Org key from https://app.buildbuddy.io/ -> Settings
#   UPLOAD_TOKEN           Bearer token the remote build script uses to PUT
#                          artifacts back to this worker.
#
# Each of the 3 secret_text bindings above is independently optional on
# every deploy after the first: leaving one unset makes this script send
# an `inherit`-type binding for it instead of `secret_text`, which tells
# Cloudflare to carry the existing bound value forward from the
# currently-live script version unchanged — no need to know/resupply a
# secret's value just to redeploy worker.js's code. `?bindings_inherit=strict`
# on the upload makes this fail loudly (not silently drop the binding) if
# there's no previous version to inherit from — i.e. on this script's very
# first-ever deploy, all 3 of these *are* required.
#
# Usage (rotating/first deploy):
#   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
#   export TANGLED_WEBHOOK_SECRET=... BUILDBUDDY_API_KEY=... UPLOAD_TOKEN=...
#   ./deploy.sh
#
# Usage (code-only redeploy, preserving existing secrets):
#   export CLOUDFLARE_API_TOKEN=...
#   ./deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="artifacts"
BUCKET_NAME="proxy-latha-org-artifacts"
HOSTNAME="artifacts.latha.org"
ZONE_NAME="latha.org"
API="https://api.cloudflare.com/client/v4"

: "${CLOUDFLARE_API_TOKEN:?export CLOUDFLARE_API_TOKEN}"
: "${TANGLED_WEBHOOK_SECRET:=}"
: "${BUILDBUDDY_API_KEY:=}"
: "${UPLOAD_TOKEN:=}"

auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "--- deriving CLOUDFLARE_ACCOUNT_ID from API token" >&2
  CLOUDFLARE_ACCOUNT_ID="$(curl -fsS "${auth[@]}" "$API/accounts" | jq -r '.result[0].id')"
  if [[ -z "$CLOUDFLARE_ACCOUNT_ID" || "$CLOUDFLARE_ACCOUNT_ID" == "null" ]]; then
    echo "error: could not derive CLOUDFLARE_ACCOUNT_ID from API token — set it explicitly" >&2
    exit 1
  fi
  echo "derived CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID" >&2
fi

echo "--- ensure R2 bucket $BUCKET_NAME" >&2
curl -fsS "${auth[@]}" -X POST \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET_NAME\"}" \
  | jq -c '{success, errors}' || true
# (a 10004 "bucket already exists" error here is fine on re-deploy)

echo "--- upload worker script $SCRIPT_NAME" >&2
# secret_binding NAME VALUE_VAR: emits a real secret_text binding when
# VALUE_VAR is non-empty, else an inherit binding that carries forward
# whatever's already bound to NAME on the live script (see the header
# comment above).
secret_binding() {
  local name="$1" val="$2"
  if [[ -n "$val" ]]; then
    jq -n --arg name "$name" --arg text "$val" '{type: "secret_text", name: $name, text: $text}'
  else
    jq -n --arg name "$name" '{type: "inherit", name: $name}'
  fi
}

metadata="$(jq -n \
  --arg main "worker.js" \
  --arg bucket "$BUCKET_NAME" \
  --argjson webhook_secret_binding "$(secret_binding TANGLED_WEBHOOK_SECRET "$TANGLED_WEBHOOK_SECRET")" \
  --argjson bb_key_binding "$(secret_binding BUILDBUDDY_API_KEY "$BUILDBUDDY_API_KEY")" \
  --argjson upload_token_binding "$(secret_binding UPLOAD_TOKEN "$UPLOAD_TOKEN")" \
  '{
    main_module: $main,
    compatibility_date: "2024-09-23",
    bindings: [
      {type: "r2_bucket", name: "ARTIFACTS", bucket_name: $bucket},
      $webhook_secret_binding,
      $bb_key_binding,
      $upload_token_binding
    ]
  }')"

# bindings_inherit=strict: fail this request (not silently drop the
# binding) if any inherit-type binding above can't be resolved against
# the previous script version — e.g. this script's actual first-ever
# deploy, when there is no previous version to inherit from.
curl -fsS "${auth[@]}" -X PUT \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT_NAME?bindings_inherit=strict" \
  -F "metadata=$metadata;type=application/json" \
  -F "worker.js=@$ROOT/worker.js;type=application/javascript+module" \
  | jq -c '{success, errors}'

echo "--- look up zone id for $ZONE_NAME" >&2
zone_id="$(curl -fsS "${auth[@]}" "$API/zones?name=$ZONE_NAME" | jq -r '.result[0].id')"
if [[ -z "$zone_id" || "$zone_id" == "null" ]]; then
  echo "error: zone $ZONE_NAME not found on this Cloudflare account/token" >&2
  exit 1
fi
echo "zone_id=$zone_id" >&2

echo "--- attach custom domain $HOSTNAME" >&2
curl -fsS "${auth[@]}" -X PUT \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg hostname "$HOSTNAME" \
    --arg service "$SCRIPT_NAME" \
    --arg zone_id "$zone_id" \
    '{hostname: $hostname, service: $service, environment: "production", zone_id: $zone_id}')" \
  | jq -c '{success, errors, result: {hostname: .result.hostname}}'

echo "ok: https://$HOSTNAME/ is live" >&2
echo "Next, for each app in worker.js's APPS registry: its Tangled repo ->" >&2
echo "Settings -> Hooks -> new webhook" >&2
echo "  Payload URL: https://$HOSTNAME/webhook/<app-slug>" >&2
echo "  Secret: (the TANGLED_WEBHOOK_SECRET value used above)" >&2
echo "  Events: push" >&2
