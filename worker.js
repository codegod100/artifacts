// artifacts.latha.org — Tangled webhook relay + build artifact clearing
// house for all of nandi's apps (not just one repo).
//
// Flow, per registered app (see APPS below): push to that app's tangled.org
// repo → Tangled fires a `push` webhook at
// https://artifacts.latha.org/webhook/<app> → verify HMAC → kick a
// BuildBuddy remote run (clones the repo, runs its buck2 build targets on
// BuildBuddy's own RE cluster, real action-cache reuse) → the remote script
// PUTs finished artifacts back to this Worker, keyed under
// artifacts/<app>/... → stored in R2 → served back out at:
//
//   https://artifacts.latha.org/artifacts/<app>/<sha>/<filename>
//   https://artifacts.latha.org/artifacts/<app>/latest/<filename>   (newest)
//
// Tag pushes additionally publish tag-only targets to that app's tangled.org
// repo as sh.tangled.repo.artifact release records (see "tangled release
// publishing" below).
//
// This Worker used to be sleek-only (cloudflare/proxy-latha-org/ in the
// sleek repo, served at proxy.latha.org) — moved to its own repo and
// generalized to a multi-app registry so other projects can be added
// without forking the whole thing. The R2 bucket underneath kept its
// original name (proxy-latha-org-artifacts) rather than being
// recreated+migrated — Cloudflare has no rename/bucket-to-bucket copy
// primitive, and the existing bucket already holds the atproto OAuth
// session + sleek's build history, not worth losing for a cosmetic rename.
//
// No npm deps — plain ES module Worker, deployable via the raw Cloudflare
// API with curl (see deploy.sh). Bindings/secrets expected:
//   env.ARTIFACTS              R2 bucket binding
//   env.TANGLED_WEBHOOK_SECRET HMAC secret — same value goes into every
//                               registered app's Tangled Settings → Hooks
//   env.BUILDBUDDY_API_KEY     org key, https://app.buildbuddy.io/ → Settings
//   env.UPLOAD_TOKEN            bearer token the remote build script uses to
//                               PUT artifacts back here (never touches git)

// --- app registry -----------------------------------------------------------
//
// Add a new app by adding an entry here — nothing else in this file is
// sleek-specific. `slug` (the object key) is the app segment in every URL
// (/webhook/<slug>, /artifacts/<slug>/..., /publish-release/<slug>/<tag>)
// and the R2 key prefix everything for that app is stored under.
//
//   cloneUrl  the tangled.org URL Tangled's webhook payload's repo doesn't
//             reliably carry (see triggerBuildForRef's comment) — hardcoded
//             per app, confirmed to actually clone+resolve correctly.
//   repoDid   that app's own repo DID (from `git remote -v` on a checkout —
//             the `tangled` remote is git@tangled.org:did:plc:..., NOT the
//             owner's personal DID). Goes in sh.tangled.repo.artifact's
//             `repoDid` field.
//   targets   buck2 targets to build. `filename` is what the artifact is
//             stored/served as; `tagOnly: true` skips it on plain branch
//             pushes (only built + published on a tag push).
const APPS = {
  sleek: {
    cloneUrl: "https://tangled.org/nandi.uk/sleek",
    repoDid: "did:plc:eimwo4adqwppiiweleayixez",
    targets: [
      { buckTarget: "//:sleek-android-apk", filename: "sleek.apk", contentType: "application/vnd.android.package-archive", tagOnly: false },
      { buckTarget: "//:sleek-host", filename: "sleek-x86_64-linux", contentType: "application/octet-stream", tagOnly: true },
    ],
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.startsWith("/webhook/")) {
      return handleWebhook(request, env, ctx, url);
    }
    if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
      return handleUpload(request, env, url);
    }
    // Cloudflare Workers reject request bodies over ~100MB — confirmed live,
    // a single-shot PUT of a 617MB flatpak bundle got a 413. R2's native
    // multipart upload API lets a build script stream it in chunks instead
    // (each chunk is its own small request; only the final completion call
    // needs the accumulated part list, which the build script itself
    // tracks across the run — no server-side state needed).
    if (request.method === "POST" && url.pathname.startsWith("/upload-init/")) {
      return handleUploadInit(request, env, url);
    }
    if (request.method === "PUT" && url.pathname.startsWith("/upload-part/")) {
      return handleUploadPart(request, env, url);
    }
    if (request.method === "POST" && url.pathname.startsWith("/upload-complete/")) {
      return handleUploadComplete(request, env, url);
    }
    if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      return handleDownload(request, env, url);
    }
    if (request.method === "POST" && url.pathname.startsWith("/publish-release/")) {
      return handlePublishRelease(request, env, url);
    }
    // Maintenance escape hatch for a bad/test sh.tangled.repo.artifact
    // record — same UPLOAD_TOKEN auth as everything else, deliberately not
    // exposed any other way (no listing endpoint).
    if (request.method === "POST" && url.pathname === "/admin/delete-record") {
      return handleAdminDeleteRecord(request, env, url);
    }
    // atproto OAuth — lets nandi authorize this Worker once, via a URL, to
    // publish sh.tangled.repo.artifact release records to tangled.org
    // instead of pasting an app password. Shared across every app in
    // APPS — one publisher identity, not per-app. See the block near the
    // bottom of this file.
    if (request.method === "GET" && url.pathname === "/client-metadata.json") {
      return handleClientMetadata();
    }
    if (request.method === "GET" && url.pathname === "/oauth/login") {
      return handleOAuthLogin(env);
    }
    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env, url);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return handleIndex(env);
    }
    return new Response("not found", { status: 404 });
  },
};

// --- webhook intake -------------------------------------------------------

async function handleWebhook(request, env, ctx, url) {
  const appSlug = url.pathname.replace(/^\/webhook\//, "").replace(/\/$/, "");
  const app = APPS[appSlug];
  if (!app) return new Response(`unknown app ${JSON.stringify(appSlug)}`, { status: 404 });

  const rawBody = await request.text();

  if (env.TANGLED_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get("X-Tangled-Signature-256");
    const ok = await verifySignature(env.TANGLED_WEBHOOK_SECRET, rawBody, sigHeader);
    if (!ok) return new Response("bad signature", { status: 401 });
  }

  const event = request.headers.get("X-Tangled-Event") || "";
  if (event !== "push") {
    return new Response(`ok: ignored event ${event}`, { status: 200 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // main pushes build just the always-on targets; tag pushes additionally
  // build tagOnly targets and publish everything as sh.tangled.repo.artifact
  // release records (see handlePublishRelease) — everything else (feature
  // branches, etc.) is ignored.
  const isMain = payload.ref === "refs/heads/main";
  const tagMatch = typeof payload.ref === "string" ? payload.ref.match(/^refs\/tags\/(.+)$/) : null;
  if (!isMain && !tagMatch) {
    return new Response(`ok: ignored ref ${payload.ref}`, { status: 200 });
  }
  const tagName = tagMatch ? tagMatch[1] : null;

  const sha = payload.after;
  if (!sha) {
    return new Response("missing after", { status: 400 });
  }

  // Respond fast (Tangled times out at 30s + retries on 5xx); resolve the
  // tag's real commit (if this is a tag push) and trigger the BuildBuddy
  // run after responding — see triggerBuildForRef()'s own comment for why
  // a tag push needs an extra resolution step sha alone doesn't cover.
  ctx.waitUntil(triggerBuildForRef(env, appSlug, app, sha, tagName));
  return new Response(`ok: build queued for ${appSlug}@${sha}${tagName ? ` (tag ${tagName})` : ""}`, { status: 200 });
}

async function triggerBuildForRef(env, appSlug, app, sha, tagName) {
  let buildSha = sha;
  // The tag's own hash (what sh.tangled.repo.artifact's `tag` field
  // wants — confirmed empirically to be the *peeled commit*, not the tag
  // object's own sha, despite how that field reads; see the sleek repo's
  // publish-notes memory for how this was root-caused) — for annotated
  // tags payload.after is the tag OBJECT's sha, so it needs resolving via
  // resolveTagCommit() below; for lightweight tags payload.after is
  // already the commit, no separate object exists. Captured here, before
  // buildSha gets overwritten with the resolved commit, and passed
  // straight into buildScript() as a literal — deliberately not resolved
  // via `git rev-parse refs/tags/<name>` on the trigger executor, since
  // that ref is never fetched there (BuildBuddy's checkout uses
  // commit_sha, which fetches only that one commit object, not any tag
  // refs pointing at it).
  let tagHash = tagName ? sha : null;
  if (tagName) {
    const resolved = await resolveTagCommit(app.cloneUrl, tagName);
    if (!resolved) {
      console.error(`could not resolve a commit for ${appSlug} tag ${tagName} (tag object ${sha})`);
      return;
    }
    buildSha = resolved;
    // The resolved commit *is* the peeled sha sh.tangled.repo.artifact
    // wants — reuse it instead of the raw tag-object sha above.
    tagHash = resolved;
  }
  await triggerBuild(env, appSlug, app, buildSha, { tagName, tagHash });
}

async function resolveTagCommit(cloneUrl, tagName) {
  const res = await fetch(`${cloneUrl}/tags/${encodeURIComponent(tagName)}`);
  if (!res.ok) return null;
  const html = await res.text();
  const shas = [...new Set([...html.matchAll(/\/commit\/([0-9a-f]{40})/g)].map((m) => m[1]))];
  // Only trust this if the page links to exactly one commit — anything
  // else (0, or >1 from some future page layout change) means this
  // scrape can't be trusted to have found the right one.
  return shas.length === 1 ? shas[0] : null;
}

async function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const given = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(computed, given);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- BuildBuddy trigger -----------------------------------------------

function buildScript(env, appSlug, app, sha, tagName, tagHash) {
  const uploadBase = `https://artifacts.latha.org/upload/${appSlug}/${sha}`;
  // Runs on a BuildBuddy remote-bazel executor. The actual compile happens
  // on BuildBuddy's RE cluster (each app's own platforms/defs.bzl RBE
  // image) — this trigger executor only needs the lightweight buck2
  // client itself, not a self-installed toolchain holding gigabytes of
  // build state.
  const steps = [
    "set -euo pipefail",
    "if ! command -v buck2 >/dev/null 2>&1; then",
    "  mkdir -p \"$HOME/.local/bin\"",
    // musl, not gnu: the gnu build needs glibc >=2.32 and BuildBuddy's
    // hosted executor image is older than that — musl is statically
    // linked so it has no glibc dependency at all.
    "  curl -fsSL -o /tmp/buck2.zst https://github.com/facebook/buck2/releases/download/latest/buck2-x86_64-unknown-linux-musl.zst",
    "  command -v zstd >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y zstd)",
    '  zstd -d -f /tmp/buck2.zst -o "$HOME/.local/bin/buck2"',
    '  chmod +x "$HOME/.local/bin/buck2"',
    "fi",
    'export PATH="$HOME/.local/bin:$PATH"',
    // Not committed (.buckconfig.local is git-ignored in every app repo) —
    // the checked-in .buckconfig instead reads $BUILDBUDDY_API_KEY straight
    // from the environment for [buck2_re_client]'s http_headers.
    `export BUILDBUDDY_API_KEY="${env.BUILDBUDDY_API_KEY}"`,
    // A stale `buckd` daemon left running from a previous run on a reused
    // trigger-executor host can point at an earlier run's now-deleted
    // buck-out/v2 (the checkout step's `git clean -x -d --force` deletes
    // it). `buck2 killall` tears down any daemon for this project root so
    // the next buck2 command starts fresh. Harmless/no-op otherwise.
    "buck2 killall || true",
    "buck2 --version",
    "echo '--- disk before build ---'; df -h / || true",
  ];

  const buildAndUpload = (target) => {
    // Plain (non-indirect) shell var, named from the sanitized filename —
    // substituted here at generation time, so the emitted script never
    // needs bash-only ${!indirection}.
    const varName = `out_${target.filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const logFile = `/tmp/buck2-build-${target.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;
    return [
      `buck2 build --show-output ${target.buckTarget} 2>&1 | tee ${logFile}`,
      `${varName}=$(grep '^root${target.buckTarget} ' ${logFile} | awk '{print $2}')`,
      `[ -n "$${varName}" ] && [ -f "$${varName}" ] || { echo "buck2 build did not produce ${target.buckTarget} output"; exit 1; }`,
      `curl -fsS -X PUT "${uploadBase}/${target.filename}" -H "Authorization: Bearer ${env.UPLOAD_TOKEN}" --data-binary @"$${varName}"`,
    ];
  };

  // Ask the Worker to publish `filename` (already uploaded to
  // `${uploadBase}/${filename}` by this point) as a sh.tangled.repo.artifact
  // release record (see handlePublishRelease). Best-effort — the file is
  // already safely in R2 by the time this runs, so a publish failure here
  // (e.g. OAuth was never completed via /oauth/login) shouldn't fail the
  // whole build; check /artifacts/<app>/releases/<tag>/<filename>.json
  // after for the actual outcome.
  const publishStep = (filename) =>
    `curl -fsS -X POST "https://artifacts.latha.org/publish-release/${appSlug}/${encodeURIComponent(tagName)}" ` +
    `-H "Authorization: Bearer ${env.UPLOAD_TOKEN}" -H "content-type: application/json" ` +
    `-d "{\\"sha\\":\\"${sha}\\",\\"tagHash\\":\\"${tagHash}\\",\\"filename\\":\\"${filename}\\"}" ` +
    `|| echo "release publish failed (${filename} is still uploaded at ${uploadBase}/${filename})"`;

  for (const target of app.targets) {
    if (target.tagOnly && !tagName) continue;
    steps.push(...buildAndUpload(target));
    if (tagName) steps.push(publishStep(target.filename));
  }
  steps.push("echo '--- disk after build ---'; df -h / || true");
  return steps.join("\n");
}

async function triggerBuild(env, appSlug, app, sha, { tagName, tagHash } = {}) {
  const body = {
    repo: app.cloneUrl,
    // commit_sha pins the exact checkout regardless of ref type — required
    // for tag pushes (a tag ref only populates FETCH_HEAD on BuildBuddy's
    // hosted-runner checkout, not `origin/<tag>`, so branch-style ref
    // resolution fails for tags; commit_sha sidesteps that entirely).
    commit_sha: sha,
    // branch is *also* sent, but only for main-branch pushes, purely as a
    // snapshot-affinity hint — skip it for tag pushes so there's no
    // `branch` value that could reintroduce ref-type resolution.
    ...(tagName ? {} : { branch: "main" }),
    steps: [{ run: buildScript(env, appSlug, app, sha, tagName, tagHash) }],
  };
  const resp = await fetch("https://app.buildbuddy.io/api/v1/Run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-buildbuddy-api-key": env.BUILDBUDDY_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.log("buildbuddy trigger failed", resp.status, respText);
    await env.ARTIFACTS.put(
      `${appSlug}/${sha}/invocation.json`,
      JSON.stringify({ triggeredAt: new Date().toISOString(), triggerFailed: true, status: resp.status, body: respText }),
    );
    return;
  }
  // Record the invocation ID immediately (not just once the build finishes)
  // so a run can be looked up via BuildBuddy's GetInvocation/GetLog APIs
  // (they need an invocationId; there's no commit-sha lookup for runs
  // triggered this way) without waiting on the build itself.
  let invocationId = null;
  try {
    invocationId = JSON.parse(respText).invocationId || null;
  } catch {
    // leave null; still record that a trigger happened
  }
  await env.ARTIFACTS.put(
    `${appSlug}/${sha}/invocation.json`,
    JSON.stringify({ triggeredAt: new Date().toISOString(), invocationId }),
  );
}

// --- artifact storage (R2) -------------------------------------------------

async function handleUpload(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const key = url.pathname.replace(/^\/upload\//, "");
  if (!key) return new Response("missing key", { status: 400 });

  await env.ARTIFACTS.put(key, request.body);
  await mirrorToLatest(env, key); // stable "<app>/latest/<filename>" alias

  return new Response(`ok: stored ${key}`, { status: 200 });
}

function checkUploadAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return env.UPLOAD_TOKEN && auth === `Bearer ${env.UPLOAD_TOKEN}`;
}

// key is "<app>/<sha>/<filename>" — mirrors to "<app>/latest/<filename>",
// keeping the app-scoped prefix rather than flattening it away.
async function mirrorToLatest(env, key) {
  const parts = key.split("/");
  if (parts.length < 3) return; // not a "<app>/<sha>/<filename>"-shaped key
  const [appSlug, , ...rest] = parts;
  const filename = rest.join("/");
  const stored = await env.ARTIFACTS.get(key);
  if (stored) await env.ARTIFACTS.put(`${appSlug}/latest/${filename}`, stored.body);
}

async function handleUploadInit(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const key = url.pathname.replace(/^\/upload-init\//, "");
  if (!key) return new Response("missing key", { status: 400 });
  const mpu = await env.ARTIFACTS.createMultipartUpload(key);
  return new Response(JSON.stringify({ uploadId: mpu.uploadId, key: mpu.key }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleUploadPart(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const key = url.pathname.replace(/^\/upload-part\//, "");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!key || !uploadId || !partNumber) return new Response("missing key/uploadId/partNumber", { status: 400 });
  const mpu = env.ARTIFACTS.resumeMultipartUpload(key, uploadId);
  const part = await mpu.uploadPart(partNumber, request.body);
  return new Response(JSON.stringify({ partNumber: part.partNumber, etag: part.etag }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleUploadComplete(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const key = url.pathname.replace(/^\/upload-complete\//, "");
  const uploadId = url.searchParams.get("uploadId");
  if (!key || !uploadId) return new Response("missing key/uploadId", { status: 400 });
  let parts;
  try {
    parts = JSON.parse(await request.text());
  } catch {
    return new Response("bad json parts list", { status: 400 });
  }
  const mpu = env.ARTIFACTS.resumeMultipartUpload(key, uploadId);
  await mpu.complete(parts);
  await mirrorToLatest(env, key);
  return new Response(`ok: completed multipart upload for ${key}`, { status: 200 });
}

// --- tangled release publishing (sh.tangled.repo.artifact) ---------------

function b64Standard(bytesLike) {
  let bin = "";
  for (const b of new Uint8Array(bytesLike)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// The lexicon's `tag` field is `bytes` constrained to exactly 20 bytes —
// the raw binary SHA-1 digest of the git commit the tag points at, not its
// 40-character hex string. hexToBytes() does the hex-pair -> raw-byte
// conversion; atprotoBytes() wraps those raw bytes in the
// `{"$bytes": "<base64>"}` JSON form the atproto data model uses to
// represent a `bytes`-typed field (a bare base64 *string* value decodes as
// a `string`-typed field instead — silently the wrong CBOR type).
function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error(`hexToBytes: odd-length hex string ${JSON.stringify(hex)}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function atprotoBytes(rawBytes) {
  return { $bytes: b64Standard(rawBytes) };
}

// Only a filename-extension guess — good enough for the handful of
// artifact kinds actually published this way; anything unrecognized falls
// back to a generic "just bytes" content type.
function contentTypeForArtifact(filename) {
  if (filename.endsWith(".apk")) return "application/vnd.android.package-archive";
  return "application/octet-stream";
}

// uploadBlob + createRecord against nandi's own PDS, authenticated with the
// stored OAuth session. Throws on any failure — caller decides what to do
// with that (the artifact itself is already safely in R2 by the time this
// runs).
async function publishTangledArtifact(session, { repoDid, bytes, filename, tagHashHex }) {
  const uploadResp = await dpopFetch(`${session.pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: { "content-type": contentTypeForArtifact(filename) },
    body: bytes,
    dpopKeys: session.dpopKeys,
    accessToken: session.accessToken,
  });
  if (!uploadResp.ok) throw new Error(`uploadBlob failed: ${uploadResp.status} ${await uploadResp.text()}`);
  const { blob } = await uploadResp.json();

  // repoDid: the app's own repo DID (not nandi's personal DID) — despite
  // the similar name, the lexicon's `repo` field is at-uri typed (a
  // pointer to a sh.tangled.repo.repo *record*), not this plain-DID field.
  const record = {
    repoDid,
    tag: atprotoBytes(hexToBytes(tagHashHex)),
    name: filename,
    artifact: blob,
    createdAt: new Date().toISOString(),
  };
  const createResp = await dpopFetch(`${session.pds}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: session.sub, collection: "sh.tangled.repo.artifact", record }),
    dpopKeys: session.dpopKeys,
    accessToken: session.accessToken,
  });
  if (!createResp.ok) throw new Error(`createRecord failed: ${createResp.status} ${await createResp.text()}`);
  return createResp.json();
}

// Called by buildScript() after a tag-triggered build's artifact is already
// uploaded (see /publish-release/<app>/<tag> route). Not part of the atproto
// OAuth block below, but depends on it (getAtprotoSession, dpopFetch).
async function handlePublishRelease(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const rest = url.pathname.replace(/^\/publish-release\//, "");
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 0) return new Response("expected /publish-release/<app>/<tag>", { status: 400 });
  const appSlug = rest.slice(0, slashIdx);
  const tagName = decodeURIComponent(rest.slice(slashIdx + 1));
  const app = APPS[appSlug];
  if (!app) return new Response(`unknown app ${JSON.stringify(appSlug)}`, { status: 404 });
  if (!tagName) return new Response("missing tag", { status: 400 });

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { sha, tagHash, filename } = body;
  if (!sha || !tagHash || !filename) return new Response("missing sha/tagHash/filename", { status: 400 });

  const obj = await env.ARTIFACTS.get(`${appSlug}/${sha}/${filename}`);
  if (!obj) return new Response(`no artifact stored for ${appSlug}/${sha}/${filename}`, { status: 404 });
  const bytes = await new Response(obj.body).arrayBuffer();

  const session = await getAtprotoSession(env);
  if (!session) {
    return new Response(
      "not authorized to publish — visit https://artifacts.latha.org/oauth/login once, then retry",
      { status: 401 },
    );
  }

  // Keyed by filename, not just tagName — a tag push can publish more than
  // one artifact (e.g. an apk and a desktop binary), and a single
  // `<app>/releases/<tag>.json` would have the second call's result
  // silently clobber the first's.
  const recordKey = `${appSlug}/releases/${tagName}/${filename}.json`;
  try {
    const result = await publishTangledArtifact(session, { repoDid: app.repoDid, bytes, filename, tagHashHex: tagHash });
    await env.ARTIFACTS.put(recordKey, JSON.stringify({
      tagName, sha, tagHash, filename, publishedAt: new Date().toISOString(), record: result,
    }));
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (e) {
    await env.ARTIFACTS.put(recordKey, JSON.stringify({
      tagName, sha, tagHash, filename, failedAt: new Date().toISOString(), error: e.message,
    }));
    return new Response(`publish failed: ${e.message}`, { status: 502 });
  }
}

async function handleAdminDeleteRecord(request, env, url) {
  if (!checkUploadAuth(request, env)) return new Response("unauthorized", { status: 401 });
  const rkey = url.searchParams.get("rkey");
  if (!rkey) return new Response("missing ?rkey=", { status: 400 });
  const session = await getAtprotoSession(env);
  if (!session) return new Response("no atproto session", { status: 401 });
  const resp = await dpopFetch(`${session.pds}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: session.sub, collection: "sh.tangled.repo.artifact", rkey }),
    dpopKeys: session.dpopKeys,
    accessToken: session.accessToken,
  });
  return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
}

async function handleDownload(request, env, url) {
  const key = url.pathname.replace(/^\/artifacts\//, "");
  // oauth/ holds the atproto session (refresh token + DPoP private key) in
  // this same R2 bucket — never let it be fetched through the public
  // artifact route.
  if (key.startsWith("oauth/")) return new Response("not found", { status: 404 });
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

// --- index page -------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// GET / — a plain landing page linking every registered app's artifacts.
// "<app>/latest/*" is listed dynamically (one R2 list() per app) since it
// changes on every main-branch build; a flatpak repo (if any) is detected
// by probing for "<app>/repo/config" and any "<app>/*.flatpakref" file in
// that same listing, rather than hardcoded per app.
async function handleIndex(env) {
  const sections = [];
  for (const [appSlug, app] of Object.entries(APPS)) {
    const listing = await env.ARTIFACTS.list({ prefix: `${appSlug}/` });
    const keys = listing.objects.map((o) => o.key);

    const latestFiles = keys
      .filter((k) => k.startsWith(`${appSlug}/latest/`))
      .map((k) => k.slice(`${appSlug}/latest/`.length))
      .sort();
    const hasRepo = keys.includes(`${appSlug}/repo/config`);
    const flatpakrefs = keys.filter((k) => new RegExp(`^${appSlug}/[^/]+\\.flatpakref$`).test(k));

    const latestItems = latestFiles.length
      ? latestFiles.map((f) => `<li><a href="/artifacts/${appSlug}/latest/${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`).join("\n        ")
      : "<li><em>none built yet</em></li>";

    const flatpakBlock = hasRepo && flatpakrefs.length
      ? flatpakrefs.map((ref) => `
      <p><strong>Flatpak:</strong></p>
      <pre>flatpak install --user https://artifacts.latha.org/artifacts/${ref}</pre>`).join("\n")
      : "";

    sections.push(`<section>
      <h2>${escapeHtml(appSlug)}</h2>
      <p><a href="${app.cloneUrl}">${escapeHtml(app.cloneUrl.replace(/^https?:\/\//, ""))}</a></p>
      ${flatpakBlock}
      <p><strong>Latest main-branch builds:</strong></p>
      <ul>
        ${latestItems}
      </ul>
      <p>Tagged releases publish <code>sh.tangled.repo.artifact</code> records — see that
         repo's tag pages on tangled.org for the <strong>Artifacts</strong> section.</p>
    </section>`);
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>artifacts.latha.org</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  pre { background: #f0f0f0; padding: 0.6rem 0.8rem; overflow-x: auto; border-radius: 4px; }
  code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
  ul { padding-left: 1.3rem; }
  a { color: #0554b3; }
  footer { margin-top: 3rem; font-size: 0.85rem; color: #666; }
</style>
</head>
<body>
<h1>artifacts.latha.org</h1>
<p>Build artifact clearing house for nandi's apps.</p>

${sections.join("\n")}

<footer>Source: <a href="https://tangled.org/nandi.uk/artifacts">tangled.org/nandi.uk/artifacts</a>
  · <a href="https://github.com/codegod100/artifacts">github.com/codegod100/artifacts</a></footer>
</body>
</html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// --- atproto OAuth ---------------------------------------------------------
//
// Lets nandi authorize this Worker once, by visiting a URL and clicking
// approve, instead of generating/pasting an app password. Standard atproto
// OAuth: no client_secret — client_id is a URL to a hosted metadata document
// (this Worker serves it). Pushed Authorization Request (PAR) + PKCE +
// DPoP-bound tokens are all mandatory parts of the protocol, not optional
// extras. The resulting session (refresh token + the DPoP keypair it's
// bound to) is stashed in the same R2 bucket as build artifacts, under an
// `oauth/` prefix that handleDownload refuses to ever serve publicly. One
// session, shared by every app in APPS — nandi's own identity is the
// publisher for all of them.

const ATPROTO_CLIENT_ID = "https://artifacts.latha.org/client-metadata.json";
const ATPROTO_REDIRECT_URI = "https://artifacts.latha.org/oauth/callback";
const ATPROTO_SCOPE = "atproto transition:generic";
// nandi's personal DID (handle nandi.uk resolves here; DIDs are the stable
// identifier, handles can change). Not any individual app's repo DID —
// that's per-app in APPS above, used only for the artifact record's
// `repoDid` field.
const ATPROTO_DID = "did:plc:ngokl2gnmpbvuvrfckja3g7p";

function b64url(bytesLike) {
  let bin = "";
  for (const b of new Uint8Array(bytesLike)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(str) {
  return b64url(new TextEncoder().encode(str));
}
function randomB64url(byteLen) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return b64url(arr);
}
async function sha256(input) {
  return crypto.subtle.digest("SHA-256", typeof input === "string" ? new TextEncoder().encode(input) : input);
}

async function generateDpopKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  delete publicJwk.d;
  return { privateJwk, publicJwk };
}

// One DPoP proof JWT, signed fresh per request (each needs its own `jti`).
// `nonce` is the server-issued DPoP-Nonce from a prior response, once we
// have one. `accessToken`, when present, adds the `ath` claim required on
// resource-server requests (not needed for PAR/token-endpoint calls).
async function signDpopProof(privateJwk, publicJwk, { htm, htu, nonce, accessToken }) {
  const key = await crypto.subtle.importKey(
    "jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  };
  const payload = { jti: randomB64url(16), htm, htu, iat: Math.floor(Date.now() / 1000) };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = b64url(await sha256(accessToken));
  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  // WebCrypto's ECDSA/P-256 signature output is already the raw r||s format
  // JOSE/ES256 wants — no DER re-encoding needed.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

// POSTs with a DPoP proof, handling the mandatory nonce dance every atproto
// auth/resource server does: first attempt commonly 400s with
// {"error":"use_dpop_nonce"} plus a DPoP-Nonce response header; retry once
// with that nonce baked into the proof.
async function dpopFetch(url, { method = "POST", body, headers = {}, dpopKeys, nonce, accessToken } = {}) {
  const attempt = async (n) => {
    const proof = await signDpopProof(dpopKeys.privateJwk, dpopKeys.publicJwk, { htm: method, htu: url, nonce: n, accessToken });
    const h = { ...headers, DPoP: proof };
    if (accessToken) h["Authorization"] = `DPoP ${accessToken}`;
    return fetch(url, { method, headers: h, body });
  };
  let resp = await attempt(nonce);
  // The auth/token endpoints signal a required nonce with 400 + a JSON
  // {"error":"use_dpop_nonce"} body. Resource-server endpoints (uploadBlob,
  // createRecord) instead use 401 + a WWW-Authenticate header. Check both;
  // either way a DPoP-Nonce response header carries the value to retry
  // with.
  if (resp.status === 400 || resp.status === 401) {
    let isNonceError = (resp.headers.get("WWW-Authenticate") || "").includes("use_dpop_nonce");
    if (!isNonceError) {
      try {
        const errBody = await resp.clone().json();
        isNonceError = errBody.error === "use_dpop_nonce";
      } catch { /* not json, not a nonce error */ }
    }
    if (isNonceError && resp.headers.get("DPoP-Nonce")) {
      resp = await attempt(resp.headers.get("DPoP-Nonce"));
    }
  }
  return resp;
}

function handleClientMetadata() {
  return new Response(JSON.stringify({
    client_id: ATPROTO_CLIENT_ID,
    client_name: "artifacts.latha.org build publisher",
    client_uri: "https://artifacts.latha.org/",
    redirect_uris: [ATPROTO_REDIRECT_URI],
    scope: ATPROTO_SCOPE,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  }), { headers: { "content-type": "application/json" } });
}

// PDS lookup is dynamic (in case of migration) even though the DID is
// hardcoded; the Bluesky-hosted PDS here delegates OAuth to a separate
// entryway/authorization server, discovered via the protected-resource
// metadata rather than assumed to be the PDS itself.
async function resolvePdsAndAuthServer() {
  const didDocResp = await fetch(`https://plc.directory/${ATPROTO_DID}`);
  if (!didDocResp.ok) throw new Error(`plc.directory lookup failed: ${didDocResp.status}`);
  const didDoc = await didDocResp.json();
  const pds = didDoc.service.find((s) => s.type === "AtprotoPersonalDataServer")?.serviceEndpoint;
  if (!pds) throw new Error("no AtprotoPersonalDataServer service in DID doc");

  const resourceMetaResp = await fetch(`${pds}/.well-known/oauth-protected-resource`);
  if (!resourceMetaResp.ok) throw new Error(`oauth-protected-resource lookup failed: ${resourceMetaResp.status}`);
  const resourceMeta = await resourceMetaResp.json();
  const issuer = resourceMeta.authorization_servers?.[0];
  if (!issuer) throw new Error("no authorization_servers in protected-resource metadata");

  const authServerMetaResp = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!authServerMetaResp.ok) throw new Error(`oauth-authorization-server lookup failed: ${authServerMetaResp.status}`);
  const authServerMeta = await authServerMetaResp.json();
  return { pds, issuer, authServerMeta };
}

async function handleOAuthLogin(env) {
  try {
    const { pds, issuer, authServerMeta } = await resolvePdsAndAuthServer();
    const dpopKeys = await generateDpopKeypair();
    const verifier = randomB64url(32);
    const challenge = b64url(await sha256(verifier));
    const state = randomB64url(16);

    const parBody = new URLSearchParams({
      client_id: ATPROTO_CLIENT_ID,
      redirect_uri: ATPROTO_REDIRECT_URI,
      response_type: "code",
      scope: ATPROTO_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      login_hint: ATPROTO_DID,
    });

    const parResp = await dpopFetch(authServerMeta.pushed_authorization_request_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: parBody.toString(),
      dpopKeys,
    });
    if (!parResp.ok) {
      const t = await parResp.text();
      return new Response(`PAR request failed: ${parResp.status} ${t}`, { status: 502 });
    }
    const { request_uri } = await parResp.json();

    await env.ARTIFACTS.put(`oauth/flow/${state}.json`, JSON.stringify({
      verifier, dpopKeys, pds, issuer, authServerMeta, createdAt: new Date().toISOString(),
    }));

    const authUrl = new URL(authServerMeta.authorization_endpoint);
    authUrl.searchParams.set("client_id", ATPROTO_CLIENT_ID);
    authUrl.searchParams.set("request_uri", request_uri);
    return Response.redirect(authUrl.toString(), 302);
  } catch (e) {
    return new Response(`oauth login setup failed: ${e.message}`, { status: 500 });
  }
}

async function handleOAuthCallback(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return new Response(`oauth error: ${err} ${url.searchParams.get("error_description") || ""}`, { status: 400 });
  if (!code || !state) return new Response("missing code/state", { status: 400 });

  const flowObj = await env.ARTIFACTS.get(`oauth/flow/${state}.json`);
  if (!flowObj) return new Response("unknown or expired oauth state — try /oauth/login again", { status: 400 });
  const flow = JSON.parse(await new Response(flowObj.body).text());

  try {
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ATPROTO_REDIRECT_URI,
      client_id: ATPROTO_CLIENT_ID,
      code_verifier: flow.verifier,
    });
    const tokenResp = await dpopFetch(flow.authServerMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
      dpopKeys: flow.dpopKeys,
    });
    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return new Response(`token exchange failed: ${tokenResp.status} ${t}`, { status: 502 });
    }
    const tokens = await tokenResp.json();

    await env.ARTIFACTS.put("oauth/session.json", JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      dpopKeys: flow.dpopKeys,
      pds: flow.pds,
      issuer: flow.issuer,
      tokenEndpoint: flow.authServerMeta.token_endpoint,
      sub: tokens.sub || ATPROTO_DID,
      updatedAt: new Date().toISOString(),
    }));
    await env.ARTIFACTS.delete(`oauth/flow/${state}.json`);

    return new Response(
      "Authorized. artifacts.latha.org's build publisher is now connected to your atproto account — you can close this tab.",
      { headers: { "content-type": "text/plain" } },
    );
  } catch (e) {
    return new Response(`oauth callback failed: ${e.message}`, { status: 500 });
  }
}

// For later use by a tag-triggered publish step: returns a valid (silently
// refreshed if needed) access token plus the DPoP key material to sign PDS
// requests with (uploadBlob / createRecord for sh.tangled.repo.artifact).
// Returns null if never authorized or the refresh token itself is dead —
// caller should fall back to pointing at /oauth/login again in that case.
async function getAtprotoSession(env) {
  const obj = await env.ARTIFACTS.get("oauth/session.json");
  if (!obj) return null;
  let session = JSON.parse(await new Response(obj.body).text());
  if (Date.now() < session.expiresAt - 60_000) return session;

  const resp = await dpopFetch(session.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: ATPROTO_CLIENT_ID,
    }).toString(),
    dpopKeys: session.dpopKeys,
  });
  if (!resp.ok) return null;
  const tokens = await resp.json();
  session = {
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || session.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    updatedAt: new Date().toISOString(),
  };
  await env.ARTIFACTS.put("oauth/session.json", JSON.stringify(session));
  return session;
}
