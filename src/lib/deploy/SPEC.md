# Deploy — implementation notes

Companion to the decision record at
`Vault/Business/tasteled/assets/deploy-specification.md`, which
stays the spec of record and carries the *why*. This file covers what is built, how to run
it, and what is deliberately not built yet.

Landed 2026-09-04: parts 1–3 of the map's five-part deploy item, plus the local half of
part 5. Landed 2026-09-05: part 4 (`zone-setup.ts`) and the cloud half of part 5
(`transform-rule.ts`) — see "Zone setup" and "One-time zone chores" below. Both change a
live Cloudflare account and default to `--dry-run`; each needs `--live` plus
`AETHR_CLOUDFLARE_API_TOKEN`/`AETHR_CLOUDFLARE_ACCOUNT_ID` to attempt a real call
(`cloudflare-api.ts` still accepts the unprefixed names as a fallback). Do not put the
unprefixed `CLOUDFLARE_API_TOKEN` in this repo's `.env` — wrangler auto-loads it and then
fails Workers Routes list (auth 10000) *after* a successful asset upload.

**`deploy.ts` is live by default** — there is no `--live` flag; pass `--dry-run` to rehearse (the opposite default from `zone-setup.ts` and `transform-rule.ts`). The replay fixture's manifest lives under the fixture vault-root
`Business/clients/_replay-maxematics/Business/clients/replay-maxematics/approved-artifact.json`
so a `replay-maxematics` folder is not created next to real clients (underscore slug is
illegal, and a bare `replay-maxematics/` would be scraped as a client). The first live staging run and its drift-guard check (2026-09-08) are recorded in `docs/state-history.md`.

**Live status, 2026-09-09 — `deploy.ts deploy` has now run live.** `deploy --domain
replay-maxematics-live.aethrdesign.com` attached three Custom Domains to
`site-replay-maxematics` (version `ceb49bd9`), serving the round-2 replay artifact
`5521a1b30f36` (56 files / 2.01 MB) at
https://replay-maxematics-live.aethrdesign.com — 200, brand token `--primary-h:262.5` in
the document, eleven section anchors, `GET /api/contact` 405.

Three things it proved that a dry-run could not:

1. **DEPLOY genuinely does not rebuild.** Wrangler's own output on the production run was
   `No updated asset files to upload. Proceeding with deployment...` — the only delta
   between STAGING and DEPLOY was two more Custom Domains on an already-live Worker.
2. **A 4-label host gets no working certificate.** `www.replay-maxematics-live.aethrdesign.com`
   *attaches* (it has a `cert_id`) but the TLS handshake returns `no peer certificate
   available`: Universal SSL covers the apex and one wildcard level, and `*.aethrdesign.com`
   does not reach four labels. This settles the "probably fine, unverified" note under
   `previewHostname`. **It does not affect a real client** — their `www.<apex>` is three
   labels and covered — but it does mean a *subdomain* can never be a complete DEPLOY
   rehearsal target. A true apex test still needs a throwaway domain.
3. **`staging` silently detaches production routes — fixed 2026-09-09, ticket 027.**

**Fixed 2026-09-09.** `staging()` reads `/accounts/{id}/workers/domains` before writing
config and carries forward any already-attached hostname that is not the preview host.
`deploy()` (and a re-stage) re-reads the same endpoint after wrangler exits and fails if
any expected hostname is missing — wrangler exiting 0 is not treated as attach success.
`scripts/publish-client.ts` uses the same preserve+verify path, because a self-edit
publish at `stage: staging` is the same write.

Measured on throwaway slug `ticket027-probe` (never `site-replay-maxematics`, never
`maxematics.org`): 1 domain after first staging → 3 after DEPLOY → **3 after re-stage**.
Wrangler listed all three Custom Domains on the re-stage; the API list agreed. Probe
Worker deleted after the run. Log:
`Business/clients/max-maxematics/05-evidence/tasteled-live-deploy-2026-09-09/logs/30-ticket027-throwaway-regression.log`.

The defect as originally measured (3 domains / apex 200 → one `staging` run → 1 domain /
apex 522, exit 0) is the behaviour this replaces. Decision record:
`Business/tasteled/tickets/027-staging-detaches-production-routes.md`.

**`zone-setup.ts` steps 2 and 3 have run live** (2026-09-09): `createTurnstileWidget` created
a real widget over the preview + apex + `www` hostnames, and `setTurnstileSecret` placed the
returned secret on the Worker via stdin. Both worked first try. Steps 1 (`addZone`) and 4
(`createRateLimitRule`) are **still dry-run only** — step 1 needs a domain not already on the
account, and step 4's PUT replaces the `http_ratelimit` entrypoint on a zone shared with the
portal, checkout and every preview host, so it is not exercised on `aethrdesign.com`.

**"Both or neither" is enforced by nothing, and it bites.** With the secret on the Worker and
a build carrying no `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, every submission 403s — measured, then
reverted by deleting the secret. Nothing in the pipeline checks that the two halves agree.

The first live transform-rule run
found a defect dry-run could not — `getExistingRules` guarded on Cloudflare error
`10001`/"not found", but an untouched ruleset phase actually returns `10003` "could not
find entrypoint ruleset", so `check` and `apply` both died on a zone with no rules. Guard
widened. Any future dry-run-only path should be assumed to carry the same class of bug.

**Wrangler auth for STAGING/DEPLOY is OAuth**, not the zone-setup token. The
`tasteled.com-live` token still 10000s on `GET /zones/…/workers/routes` even with Workers
Routes Write listed — custom-domain attach is what that call is. `run()` strips
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the wrangler child env so a sourced
shell cannot resurrect the trap.

The registrar-side nameserver change is still, and will always be, a human action — there
is no Cloudflare API for it.

---

## What a client site is

A **static export**. `next build` with `output: "export"` emits `out/` — HTML, CSS, JS and
images, no server. Measured on the shipped template: **54 files, 1.8 MB**.

The one dynamic route is `/api/contact`, which lives in `src/worker.ts` and is reached
through `run_worker_first: ["/api/contact"]`. Everything else is a static-asset hit that
never enters Cloudflare's account-wide 100,000-requests/day Worker budget — the budget
every client, the portal, checkout and the apex proxy share. **This is the whole cost
model**: a client site going viral is free; only form submissions cost anything.

Verified locally under `wrangler dev`: with the Worker's asset fallback temporarily
replaced by a 418, `/`, `/index.txt` and a missing path all still returned 200/200/404 from
assets — the Worker was not invoked for any of them.

---

## Commands

```bash
# STAGING — build, pin the artifact, attach <slug>-preview.aethrdesign.com.
# A re-stage of a client past DEPLOY keeps any production Custom Domains already attached.
npx tsx src/lib/deploy/deploy.ts staging \
  --slug meridian-partners --contact-email hello@meridianpartners.com

# DEPLOY — verify the artifact is unchanged, attach apex + www, then confirm
# /workers/domains lists every expected hostname (wrangler exit 0 is not enough).
npx tsx src/lib/deploy/deploy.ts deploy \
  --slug meridian-partners --contact-email hello@meridianpartners.com \
  --domain meridianpartners.com

# One client, immediately
npx tsx src/lib/deploy/deploy.ts rollback --slug meridian-partners
```

Flags:
- `--vault-root <path>` — path to the Vault root (defaults to `/Volumes/Main/Developer`).
  The manifest is recorded to `<vault-root>/Business/clients/<slug>/approved-artifact.json`.
- `--dry-run` — prints the generated `wrangler.jsonc` and every command without executing any
  of them.
- `--skip-build` — stages whatever is already in `out/` without rebuilding.

### DEPLOY does not rebuild, and that is enforced

STAGING records a manifest of `out/` — per-file sha256 plus an order-independent tree hash
— to `Business/clients/<slug>/approved-artifact.json` in the Vault root. DEPLOY recomputes
it and **refuses** to attach a client's apex to anything that has drifted, printing exactly
which files were changed, added or removed.

This guard exists because the precedent it replaces failed at exactly this point.
Maxematics' `deploy-live.sh` rewrote `noindex` → `index` in the HTML, deleted the
comparison pages and added files — *after* the last thing anyone looked at. Staging and
live were built from one source and were not the same bytes. Verified here by reproducing
that mutation against a recorded manifest: the deploy was refused with a named diff.

`--force` exists for the legitimate case that will eventually arrive. It says plainly in
its output that the client did not approve what is being shipped.

---

## The contact Worker

`src/worker.ts`, ~90 lines with its reasoning. Behaviour verified under `wrangler dev`:

| Request | Result |
|---|---|
| `GET /api/contact` | `405`, `Allow: POST` |
| `POST` malformed JSON | `400` "Invalid request body." |
| `POST` missing name/email/message | `400` |
| `POST` invalid email | `400` |
| `POST` valid, no `RESEND_API_KEY` | `200 {"success":true}`, submission logged |
| `POST` valid, Turnstile secret set, no token | `403` |
| `POST` valid, Turnstile secret set, bad token | `403` |

**Turnstile fails closed.** If `TURNSTILE_SECRET_KEY` is set and verification errors or the
token is missing, the submission is rejected. A client deployed before their Turnstile keys
exist has no secret set and skips the check — the only bypass, and it is explicit.

Spam is the single thing that can push the shared account past 100k requests/day and take
down every client's form, the portal and checkout together. That is why this is in the
deploy contract rather than an add-on.

### Configuration

| Name | Kind | Scope |
|---|---|---|
| `CONTACT_EMAIL` | `vars` in `wrangler.jsonc` | per client |
| `RESEND_API_KEY` | `wrangler secret` | one shared AethrDesign key |
| `TURNSTILE_SECRET_KEY` | `wrangler secret` | per client |

```bash
npx wrangler secret put RESEND_API_KEY      --name site-<slug>
npx wrangler secret put TURNSTILE_SECRET_KEY --name site-<slug>
```

**The client-side widget shipped 2026-09-04** (`src/components/ui/turnstile.tsx`, wired into
`contact.tsx`), closing the seam where parts 1 and 4 of the deploy item did not meet. The two
halves are now enabled together:

| Name | Kind | Scope |
|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | build-time env var, inlined into the static export | per client |

```bash
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key> pnpm build
```

The site key is public by design and is **not** a `SiteSpec` field: it does not exist when the
spec is written and approved — the widget is created during zone setup below — so routing it
through the spec would put a value nobody has yet into the document a human signs off on. It is
infrastructure, and it enters at BUILD.

**Both or neither.** With no site key baked in, the form renders no widget and posts no token,
which is byte-for-byte the pre-Turnstile behaviour, and a Worker with no secret accepts it. Set
the site key at BUILD and the secret on the Worker in the same pass; setting only the secret
still rejects every legitimate submission.

---

## Slugs

`validateSlug` enforces hostname rules, not filename rules: lowercase alphanumeric with
internal hyphens, ≤45 characters (so `<slug>-preview.aethrdesign.com` fits DNS's 63-char
label limit), and not one of the reserved names — `www`, `portal`, `mail`, `api`, `start`,
`internal`, `preview`, `staging`, `cdn`, `assets`.

**Run this at onboarding, not at deploy.** A slug collision discovered at DEPLOY is
discovered with a client waiting.

---

## Per-client zone setup (part 4)

`zone-setup.ts` — step 1 (client buys the domain) and the registrar-side nameserver change
in step 2 stay human actions; everything else is one command:

```bash
npx tsx src/lib/deploy/zone-setup.ts run --slug <slug> --domain <apex>              # dry-run (default)
npx tsx src/lib/deploy/zone-setup.ts run --slug <slug> --domain <apex> --live       # live — asked about per command
```

1. **Client buys the domain in their own name.** Registrar ownership, billing and legal
   title never move — not at DEPLOY, not ever. Human action, always.
2. **`addZone`** adds the client's zone to AethrDesign's account (`POST /zones`) and returns
   the nameservers to give the client — or to enter yourself with temporary registrar
   access, which is still the offer-first default; it is a five-minute action and the one
   place a $500 sale reliably stalls. The nameserver change itself has no Cloudflare API and
   stays human.
3. **`createTurnstileWidget`** creates one widget covering the preview hostname and both the
   apex and `www`, then **`setTurnstileSecret`** puts the returned secret on the Worker via
   `wrangler secret put … <(the secret, piped on stdin, never argv)`. The site key it prints
   is a BUILD input (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) — rebuild and re-stage if the site was
   built before this ran.
4. **`createRateLimitRule`** writes the one rate-limiting rule the free plan allows, via the
   Rulesets API (`http_ratelimit` phase). Defaults (60 req/60s per IP, 10-minute block) are a
   starting point, not a ruling — tune per client if warranted.
5. The command prints the `state.md` block (worker name, zone id, staging/production URLs)
   once, at the end, to paste in by hand — `state.md` is `propose`-class, same convention as
   the ANALYSIS `analysis` line; nothing here writes the file.

## One-time zone chores (part 5)

1. **`X-Robots-Tag` Transform Rule on `aethrdesign.com`** — `transform-rule.ts`.
   ```
   When   ends_with(http.host, "-preview.aethrdesign.com")
   Set    X-Robots-Tag: noindex, nofollow
   ```
   ```bash
   npx tsx src/lib/deploy/transform-rule.ts check           # report whether it's applied
   npx tsx src/lib/deploy/transform-rule.ts apply           # dry-run (default)
   npx tsx src/lib/deploy/transform-rule.ts apply --live    # live — asked about per command
   ```
   Reads the zone's existing `http_response_headers_transform` rules before writing —
   Cloudflare's rulesets API takes the whole list on write, so a bare PUT of just this rule
   would silently delete any other rule already on that phase. Identified by its
   `description`, so re-running after it's applied is a no-op. One rule covers every client
   forever; the `-preview` suffix is what makes that possible. The free plan allows 10 active
   Transform Rules per phase; this is one. **Applied live 2026-09-08** on the `aethrdesign.com` zone; re-running reports
   `already applied — nothing to do`.

   **A second rule was appended 2026-09-09**, by hand rather than through this module, to
   `noindex` the deploy-proof host `replay-maxematics-live.aethrdesign.com` and its `www`.
   The suffix rule above deliberately matches only `-preview.`, and a DEPLOY host is
   *supposed* to be indexable — that is correct for a real client and wrong for a rehearsal
   target. The phase now carries two rules; the existing one was read and preserved on write.
   Remove the second when the `-live` proof host is retired. Do not generalise it to an
   `ends_with(…, "-live.aethrdesign.com")` suffix without a ruling — that would invent a
   reserved-hostname convention nobody has decided on.

2. **`verify.sh` as a pre-deploy gate on the apex Worker** — **done 2026-09-04.**
   `aethrdesign-proxy/safe-deploy.sh` (`npm run deploy:safe`) uploads a version, runs the
   existing 16-check `verify.sh` against its preview URL, and promotes with
   `wrangler versions deploy` only on a pass. It aborts without promoting if the preview
   URL cannot be found or any check fails.

---

## Four blast radii, kept distinct

| Failure | Reach | Recovery |
|---|---|---|
| Bad client deploy | exactly one client | `wrangler rollback --name site-<slug>` |
| Bad apex-Worker deploy | marketing + portal + checkout + every preview URL — **never a live client site**, which sits on its own zone behind its own Worker | `wrangler rollback`; prevented by `safe-deploy.sh` |
| Account-wide 100k req/day cap | true shared fate — reachable only by form spam, since static traffic is exempt | Turnstile + rate limit; escape hatch is Workers Paid at $5/mo |
| Client-hosted sites | that client only | **No rollback authority.** The support promise must say so rather than implying parity |

---

## Not built here

- Retiring the preview hostname ~30 days after DEPLOY — currently a printed reminder, not a
  scheduled job.
- Per-client git repos. Generated code is disposable and `spec.json` is the only editable
  surface, so there is nothing durable to keep in forty repos. One gets created in
  `Business/clients/<slug>/` (needs a workspace-registry entry) only when the Collection CMS add-on is
  bought or a client requests source at handover. AethrDesign-owned tooling stays in `Business/apps/`.
- A cloud-callable deploy path. Not needed at v1 — the Mac triggers build and deploy — but
  `wrangler` is a client of the Workers API, so a Worker can perform the identical upload
  when the self-edit tool needs a client's 3 a.m. typo fix to publish without waiting for
  the Mac to wake.
