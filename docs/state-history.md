# aethr-base-template — state history

**2026-09-30 — `_headers` generator: client static exports now grade A+ on Mozilla HTTP Observatory (was D/30).** `src/lib/deploy/security-headers.ts` writes `out/_headers` after the build (HSTS, nosniff, X-Frame-Options, Referrer-Policy, COOP, and a per-page CSP: `default-src 'none'`, script-src `'self'` + the sha256 of each page's inline scripts — no `'unsafe-inline'`). `staging()` in `deploy.ts` calls it before the manifest. Verified on a throwaway Worker: A+ / 135, 12/12 tests, exactly one CSP header on every route; page hydrates under the CSP. Cloudflare quirks measured, not assumed: multiple CSP headers AND, so page rules detach the inherited one (`! Content-Security-Policy`) — except the root `/`, where detach did not work and the fallback is `/:seg` + `/:seg/*` instead of `/*`; 100 rules / 2,000 chars per line are hard-checked. Turnstile and Google Fonts origins are auto-detected. 13 unit tests. Not yet exercised on a real client site's staging deploy (Turnstile branch untested live). Committed here; the tasteled wiring is not (it sits inside tasteled's uncommitted cf-deploy.sh refactor).

**Next:** run one real client staging with it; then wire tasteled (done: `pnpm security-headers` in its deploy) and the portal's `security-headers` goal metric.

Older "Where we left off" entries from [`STATE.md`](../STATE.md), newest first. A historical record: entries describe the code as it was on their date, not as it is now — read the code for current behavior.

## Where we left off (archived entries)

**2026-09-25 — 2 critical Dependabot RCEs closed; real runtime exposure, not just noise.** `next` was pinned at 16.2.9 (unauthenticated RCE in Image Optimization API on AVIF, plus a Windows-hosted RCE — both patched >=16.3.3); bumped to 16.3.4, matching `aethr-portal`. Separately, `shadcn` (dev-only CLI, never imported at runtime — confirmed by grep) was sitting in `dependencies`, so its whole MCP-SDK stack (hono, qs, fast-uri, ip-address, nanoid, js-yaml, brace-expansion, postcss, sharp...) counted as runtime-scope on GitHub's dependency graph, inflating a real 2-critical issue into ~65 alerts. Moved to devDependencies; added `pnpm-workspace.yaml` overrides for the rest. Full detail: `~/.claude/plans/aethr-harden-prod-safety.md` Phase 3 State Sync (triage note). 65 alerts → 0, live-confirmed via `gh api`. Re-verified lint/typecheck/test all green after the `next` bump (16.2.9→16.3.6 resolved).

**Next:** none — this was a closed-loop fix, not an open thread.

**2026-09-24 — investigated reported Base UI `nativeButton` console warnings (header.tsx's `SheetTrigger`/`Button`, faq.tsx's `AccordionTrigger`, contact.tsx's `Button`) surfacing in aethr-portal's assembled preview — could not reproduce, no source changed.** Tested three ways: the standalone `aethr-base-template` dev server; a faithful reproduction of the portal's `SitePreview` iframe + `createPortal` canvas-edit path (throwaway route, synthetic `SiteSpec`, deleted after); and an isolated iframe + `createPortal` test with no canvas hit-testing. All three stayed clean, including opening the mobile Sheet and expanding the FAQ accordion. Base UI's check (`useButton.js`) is a post-mount `tagName === 'BUTTON'` test via Floating UI's realm-safe `isHTMLElement`, so the iframe-portal document boundary is not a plausible cause either. The only two genuine `render`-prop Button compositions in this repo — `SheetTrigger → Button` (header.tsx) and `SheetClose → Button` (sheet.tsx) — already match Base UI's documented pattern; `faq.tsx`'s `AccordionTrigger` and `contact.tsx`'s `Button` don't use `render` at all, so there is nothing to change per Base UI's own model. Best guess: a stale Fast-Refresh module instance during live editing, or an earlier file snapshot, not reproducible against current source. **If it recurs, capture the exact console message + React's component owner-stack before re-investigating** — that pins the actual mount instead of guessing at repro conditions.

**2026-09-23 — canvas-editor Phase 5 (Agent tab UI) touched nothing here.** All Phase 5 work is in `aethr-portal`; this repo's Phase 3 markers (`src/lib/edit/markers.tsx`) are consumed unchanged. Record: ticket 012 → *Canvas editor + Agent — implementation record*.

**2026-09-21 — the `src/lib/edit` seam is now machine-readable.** Phase 2 of `~/.claude/plans/aethr-refactor-edit-module-seams.md`: added `.claude/seams.json` (untracked), declaring the `edit` module's barrel, its two carve-outs (`preview`, `markers`, with reasons), test dir, and its `mirroredTo` entry for `aethr-portal/src/template/lib/edit`. Also records the `importPattern` gotcha (alias **and** `**/edit/*` path-segment match — safe here only because `src/lib/edit` is this repo's one `edit/` dir; do not copy into a repo with a second `edit/` directory, e.g. the portal). No code changed. Feeds Phase 3's drift detector, which reads this file next.

**2026-09-21 — Phase 3: the assembled carrier emits preview-only edit markers, and a built site is byte-identical without them.** `src/lib/edit/markers.tsx` (`mark` / `markList` / `markItem` / `markLocked` / `within` / `<Mark>`) emits the annotated attribute vocabulary — `data-ae`, `-type`, `-slot`, `-multiline`, `-item`, plus a new `data-ae-locked` — from the fourteen section components plus `layout/header.tsx` and `layout/footer.tsx`. `src/components/ui/rich-text.tsx` forwards unknown div props so a marker can land on it.

**Markers are an optional prop, not a React context, and that is the load-bearing decision.** A context is read with `useContext`, which would make all fourteen sections client components — eight of them are server-rendered today, and turning them client ships a hydration payload into every site we build to serve a surface no visitor ever sees. `mark(undefined, …)` returns `{}`, and `generate.ts` never passes an `edit` prop, so **the generator needs no change**: new sites get markers-off behaviour automatically and no delivered client is touched.

That claim is asserted, not assumed. `scripts/check-edit-markers-parity.ts` diffs the rendered output against `scripts/fixtures/edit-markers-baseline.html`, captured from the pre-change commit in a throwaway `git worktree`: **OK**, 152/155 field+list markers, 6 site-chrome markers, 3 render-gated. The three are FAQ answers — base-ui unmounts a collapsed panel, so there is genuinely no node to mark while the question is closed.

**Same day, a separate session closed this module's seam** (`~/.claude/plans/aethr-refactor-edit-module-seams.md`, sessions 1–2). That work is not Phase 3's and is recorded there; what matters here is the two decisions below, which Phase 3 now depends on.

**2026-09-18 — analysis layer is now private; this repo stays public (owner ruling).** `src/lib/analysis/` is untracked here (`.gitignore`) and is a nested private repo, `Chevis-Zhou/aethr-analysis` — commit and push it separately. Nothing tracked outside it imports it; a clean clone without it typechecks, so `client-publish` is unaffected. Account/zone IDs scrubbed (`82026d1`). Remaining public-history handling is owned by a separate session (owner, 2026-09-18).


**2026-09-11 (second pass) — the change runner has a second carrier, and it has now run on a live client.**
Ticket [031]. `src/lib/change/annotated.ts` is the hand-built site's half of a pass: BUILD runs that
site's `edit-layer/build.mjs` + `build-css.sh`, QA runs its `validate.mjs`, STAGING runs
`deploy-mockup.sh`, and DEPLOY **rehearses** `deploy-live.sh` unless `--live` — the target is a repo
the client's DNS serves, not our Worker. `run.ts` branches on `state.carrier`, read off the live
document at `open`, never off a flag; `--bespoke` is the owner's per-pass consent to run quoted work
through the productized machinery (no standing link, no guarantee copy on APPROVE, editor still
locks). Three things the code corrected: the drift check cannot re-hash this repo's `out/` on an
annotated pass (now `assertPinnedTree` over the pass's own surface); the shipped surface is
`index.html` + `assets/` minus `brand/`, not `mockup/`, which also holds retired builds and
screenshots; and `CNAME` / `.nojekyll` / `.DS_Store` are not the site, so a rehearsal that counted
them reported a deletion the push never makes. Proven: `check-change-pass.ts` 33/33, a full offline
`--dry-run` on a scratch vault and a scratch copy of the site, and then **the real thing** —
max-maxematics through all six stages on production, staging pushed for real, `maxematics.org`
untouched and verified untouched, pass closed as `abandoned`. `--live` on this carrier has still
never run — the change it staged was pushed to `maxematics.org` by hand afterwards
(`deploy-live.sh`, `541f0f0`), which is the same script the flag would have called.

**2026-09-11 — the change-ticket runner exists (ticket 026 execution).**
`src/lib/change/run.ts` drives a paid pass through **REVIEW → BUILD → QA → STAGING → APPROVE →
DEPLOY** with one command per stage, each refusing to run out of order. It never calls
`analysis/run.ts` (026 §0). Input is the live spec pulled from the portal; provenance is
`clients/<slug>/changes/<ISO>/` (`pass.json`, `spec.before.json`, `spec.json`, `delta.md`,
`brief.json`, `qa/`, `approved-artifact.json`). Guards: `spec.json` hashed at the REVIEW gate
(BUILD refuses an edit made after it); `out/` tree hash pinned at BUILD (QA and STAGING refuse a
tree another session built — SESSION-BRIEF §7); approval refused if the manifest was re-staged
since; one open pass per client. `deploy` does not finish until `spec.json` is **seeded as the new
live version** — skip that and the client's next self-edit publish rebuilds the pre-pass spec.
`delta.md` is 026's delta flags sheet over `isFreePath`: free-only passes, structural change on a
minor ticket, and the client's unpublished draft are flagged. `state.md` is printed, never written.
`qa/run.ts` now exports `resetGeneratedPages` / `restoreAssemblerOutputs` (no behaviour change).
Proven: `scripts/check-change-pass.ts` 23/23; full `--dry-run` rehearsal on a scratch vault from
the replay's approved spec — real assemble + `next build` + fast gate + full suite (major), then
stage/approve/deploy/close with wrangler and portal dry — working tree clean after. Not proven: any
live `stage`/`deploy` — no productized client exists. Two sample specs fail the fast gate
(hero-less pages have no `<h1>`; `_all-sections` has a duplicate footer and dead links), so they
are not usable as gate-clean fixtures.

**2026-09-10 — this repo is on GitHub again, and the shared builder has now run.**
`origin/main` had been stuck at 2026-08-21: everything from Phase 5 onward — the assembler,
the deploy and QA layers, the edit layer, and `client-publish.yml` itself — existed only in
this working tree. That is survivable for the Mac paths, which execute files in place, and
fatal for the assembled publish path, which dispatches a workflow *on GitHub*. So the cloud
builder could not have run whatever its secrets said. Pushed as `0506782`.

First run then failed at `E: Unable to locate package oxipng` — a Rust binary distributed on
GitHub releases, not an Ubuntu package. `optimize-images.ts` tolerates a missing tool per
binary; apt asked for it does not. Now installed from a pinned release (`2ee475f`).

Second run reached the portal and was answered **404 "No such publish"** for a slug with
nothing queued — **not 401**, which is what a wrong secret returns. That is
`PORTAL_BUILD_SECRET` proven across the repo↔Worker boundary. Two links in the chain are
still unexercised and both need a real assembled client: `GITHUB_DISPATCH_TOKEN` (the portal
firing the dispatch) and `CLOUDFLARE_API_TOKEN` (the runner deploying). Every client on the
books is `custom`, so there has been no occasion. Note the first deploy of any client still
runs from the Mac regardless — a first-time Custom Domain attach fails auth 10000 with a zone
token, so CI proves itself on a *re*-publish, not on the initial one.

2026-09-10, seventeenth pass — **rich text, and reader #2.** Storefront Phase 9 v1.1
(ticket 012). Nothing about ANALYSIS → QA → STAGING → DEPLOY changed; this all sits beside
it, and `aethr-portal` is still the only consumer.

**`src/lib/rich-text.ts` — the reason rich text could not ship in v1.**
The blocker was never the editor library; `about.story` and `faq.items[].answer` are
`z.string()` rendered as `{story}` in JSX, so markup in them displayed as escaped text. This
is a **parse-and-rebuild** filter over a closed tag allowlist with a scheme allowlist on
`href` — nothing from the input reaches the output as markup, and it runs on Workers with no
DOM to borrow. `about.tsx` and `faq.tsx` render through `components/ui/rich-text.tsx`;
`lib/edit/apply.ts` sanitises on the write path as well, because a spec also arrives from
ANALYSIS and from hand-edited JSON. **No migration**: a plain-text story renders as exactly
the paragraphs it always did. 17 cases in `scripts/check-rich-text.ts`.

**`src/lib/edit/annotation-*.ts` + `html-scan.ts` — reader #2, for hand-built sites.**
Ports of the pilot's `edit-layer/lib/*.mjs`, because the editor has to read the same markup
the build does and it runs in a Worker. Produces the same `FieldInventory` the assembled
reader does — 114 free fields on the Maxematics pilot — so the portal's editor UI was not
touched to gain a second carrier. The partition here is **the annotation itself** (ticket
012 amendment §B), so this file has no classification rules of its own.

**`scripts/check-annotated-parity.ts` — the port is a checked claim, not a hope.**
Renders `template.html` + `content.json` through the TypeScript path and diffs it against
what `edit-layer/build.mjs` wrote: **121,990 bytes, identical**. That equality is what lets
the portal preview a hand-built site by running the real renderer on every keystroke, which
in turn is why Phase 1's `postMessage` bridge was dropped rather than built. Also exercises
the write path's refusals — unannotated path, `data-ae-max`, link scheme, list floor.

**`FieldKind` gained `url`, and `FieldConstraints` gained `maxLength` / `minLength` /
`schemes`.** All three come from the annotated carrier and none has an analogue on the
assembled side: a Zod prop schema carries no character ceiling, and every assembled link is
paid. The absence is a fact about that substrate rather than a gap.

Template git still unpushed. Detail: `tasteled/tickets/012-client-self-edit-tool.md`
§ "Implementation record — v1.1".

2026-09-09, sixteenth pass — **ticket 027 closed and shipped onto the rehearsal Worker.**
`staging()` reads `/workers/domains` and carries forward already-attached non-preview
hostnames; `deploy()` (and staging, after wrangler) re-reads and fails if any expected
hostname is missing. `publish-client.ts` uses the same preserve+verify path. Proven on
throwaway `ticket027-probe` then shipped: restage of `site-replay-maxematics` carried
forward live+www (3 domains stayed), wrangler listed all three Custom Domains, both
preview and live 200 Maxematics / `--primary-h:262.5` (version `b17966f1`, artifact
`13f709ba6795`). `out/` had been Meridian Partners — assembled spec-v2 and rebuilt
before that restage. `maxematics.org` untouched. Template git still unpushed (`main` at
`1ccf4e0`); CI self-edit publish does not have 027 until a commit. Live staging/deploy
need `AETHR_CLOUDFLARE_*` (fail-closed).
Detail: `src/lib/deploy/SPEC.md`, ticket 027.

2026-09-09, fifteenth pass — **this repo now has a second consumer and a publish path of
its own.** Storefront Phase 9 (ticket 012, the self-edit tool) is built in `aethr-portal`
and reaches back in here for three things. Nothing about ANALYSIS → QA → STAGING → DEPLOY
changed; what is new sits beside it.

**`src/lib/edit/` — the free/paid partition, derived not restated.**
`spec-adapter.ts` walks `SECTION_PROP_SCHEMAS` and emits a *field inventory*
(`id · type · constraints · value`) plus the priced controls for everything outside it.
This is why a fifteenth section type will ship its editable fields the moment its Zod schema
exists, and why a renamed prop cannot leave a stale row pointing at a path that is gone.
`inventory.ts` is the contract the portal consumes; `apply.ts` is the write path and
re-checks the partition server-side, because the boundary is also the price list.
`preview.tsx` maps `type → the actual component` (`SECTION_REGISTRY` maps to import *paths*,
which a bundler cannot follow at runtime).

**`scripts/publish-client.ts` + `.github/workflows/client-publish.yml` — the shared cloud
builder.** One workflow builds every client; it takes a slug, not a repo, so ticket 010 §4's
"no per-client repo" is untouched. Sequence, and the order is the ruling: fetch spec →
assemble → fetch the client's uploaded images → optimize → `next build` → **fast gate** →
`wrangler deploy` → report. The gate is pre-upload so a client edit that breaks the site
never reaches a hostname.

**`src/lib/qa/fast-gate.ts`** — §5.1's checks against an already-built `out/`, with no
assemble and no rebuild. Not `runFullSuite({check:"content"})`: that assembles and builds
first because it is an oracle over a *spec*; this runs on the artifact about to be uploaded.

**Three edits to existing files, all small:**

- **Section, ui and layout components now use relative imports** instead of `@/`. Behaviour
  identical; it is what lets them compile inside another app. Nothing else changed in them.
- **Content check 2 carries the `spec.json` path** of the text it faulted (`selector`).
  Ticket 012 §4.2: the check stays blocking, but against a client self-edit the failure has
  to be locatable — "a client adds a fourth service and fails on a sentence elsewhere that
  still says three." Check 5 already anchored to the current spec, so §4.1 needed nothing.
- **`optimize-images.ts` gained a Linux lossless pass** (`oxipng` / `jpegtran`) instead of
  logging "not macOS" and skipping. That is what makes client image uploads possible at all:
  manifest coverage is blocking and ImageOptim is a macOS GUI app, but a runner has the
  binaries it wraps.

**Proven locally, end to end** against `spec-approved.json`: assemble → build → gate →
`--dry-run` deploy → report. The gate blocked one run for real — an emptied FAQ list tripped
content check 6 — and nothing was uploaded, which is the behaviour the phase exists to have.
**The GitHub Actions run itself has never executed**: it needs `PORTAL_BUILD_SECRET`,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets. Until it does, treat the
workflow as unproven — the same rule this repo applied to `zone-setup.ts`.

**Running `publish-client.ts` locally leaves the client's site in the working tree.** It is
written for a fresh CI checkout, so unlike `qa/run.ts` it neither resets stale generated
pages nor restores what `assembleFromSpec` overwrites. `git checkout -- src/app/page.tsx
src/lib/client-config.ts wrangler.jsonc` after a local run.

2026-09-08, thirteenth pass — **`deploy.ts staging` live, Maxematics replay on a real
preview host.** (Session-brief task 1 / spine Phase 5's open end.) Assembled
`spec-approved.json` from `_replay-maxematics/analysis/2026-09-06T22-44-02.255Z`, rebuilt
`out/` (56 files, 2.00 MB, tree `0ad68a8cb53a`), staged slug `replay-maxematics` (not
`max-maxematics`, not `_replay-maxematics` — `validateSlug` rejects the underscore).

- **Live:** https://replay-maxematics-preview.aethrdesign.com — `GET /` 200, headline
  present, `X-Robots-Tag: noindex, nofollow`, `GET /api/contact` 405. Worker
  `site-replay-maxematics` version `e612399d-d38a-401a-8747-f36e8831def9`. Form
  `CONTACT_EMAIL` is Chevis's, not Max's — public preview, do not spam the client.
- **First live attempt failed after a successful asset upload** (auth 10000 on
  `GET /zones/…/workers/routes`). Cause: `.env` used `CLOUDFLARE_API_TOKEN`, which wrangler
  auto-loads; that token still cannot list Workers Routes even with the permission named on
  the token. Renamed to `AETHR_CLOUDFLARE_*` (read by `cloudflare-api.ts`); `run()` strips
  the unprefixed names from the wrangler child env. OAuth then attached the custom domain.
- **Drift guard** re-run against the live-recorded manifest: mutated `index.html`, deleted
  `showcase.html`, added a file — `deploy` to `do-not-attach.invalid` refused, naming those
  three, no wrangler call. `out/` restored to the approved bytes.
- Working tree currently holds the assembled Maxematics `page.tsx` + `client-config.ts`
  from this run. Not reverted.

2026-09-06, twelfth pass — **instrumentation.** (Plan:
`~/.claude/plans/aethr-product-build-spine.md` Phase 6, gates on Phase 5.) Three numbers the
business has never recorded — REVIEW/APPROVE gate hours, add-on attach rate, REVIEW rejection
rate — now have fields and a read surface, built into the pipeline rather than retrofitted.

- **`_template/state.md`** — 5 new frontmatter fields: `review-entered`/`review-exited`,
  `approve-entered`/`approve-exited` (ISO timestamps bounding the two human gates),
  `addon-cents`. All propose-class, same convention as the existing `analysis:` line —
  pipeline scripts print, Chevis pastes. Deliberately **no** rejection-count field —
  `analysis/run.ts` already rules two `analysis/<timestamp>/` folders under one client IS the
  rejection record; the read surface counts folders instead of adding a parallel store.
- **`src/lib/analysis/run.ts`** — prints `review-entered: <ISO now>` alongside the existing
  `analysis:` stateLine when a spec reaches REVIEW.
- **`src/lib/deploy/deploy.ts`** — `staging()` prints `approve-entered` right after telling
  the owner to send the client the preview URL; `deploy()` prints `approve-exited` right after
  going live. `review-exited` has no CLI moment (REVIEW closes when Chevis manually moves the
  stage to BUILD) — documented as a manual stamp at that Stage Log row.
- **`src/lib/instrumentation/report.ts`** — the single read surface. Hand-rolled frontmatter
  parse (no new dependency — flat key:value pairs don't need `gray-matter`), scans
  `Business/clients/*/state.md`, prints mean gate hours, attach rate, rejection rate. Verified
  against synthetic fixtures (3h/6h gates, 50% attach, 100% rejection) and then a real run
  against the actual clients dir — correctly reports "no data" on all four, since no live
  productized client has reached REVIEW yet. Run: `npx tsx src/lib/instrumentation/report.ts
  [--vault-root <path>]`.

Typecheck clean (`npx tsc --noEmit`). Nothing run against real client data — this is
infrastructure with no clients through it yet.

2026-09-05, tenth pass — **the QA suite, built and verified.** (Plan:
`~/.claude/plans/aethr-product-build-spine.md` Phase 3.) `src/lib/qa/` — content checks
(all eight of §5.1), layout assertions at 390/768/1440/1920, the accessibility floor
(axe-core + Lighthouse), the asset-manifest check, the image-optimization pipeline (ported
`optimize-images.ts` + rewritten `prewarm.ts`), the report, and the orchestrator (`run.ts`,
CLI: `npx tsx src/lib/qa/run.ts --spec <path>`). Spec promoted to `src/lib/qa/SPEC.md` —
read it first, it carries every deviation and the two controls' construction in full.

Verified end to end via `npx tsx src/lib/qa/verify-qa.ts`: the negative control
(`fixtures/negative-control.json`) PARKS on all eleven expected blockers; the Maxematics v1
positive control (`fixtures/maxematics-v1.json`, the real ANALYSIS replay output with its
two REVIEW-blanked fields filled) STAGES clean — zero blockers, one performance advisory
(no threshold anywhere, by owner ruling).

**Four template regressions found and fixed while getting the positive control clean** —
`SPEC.md` has the detail, this is the one-line version: `generate.ts` never gave a section
an anchor id, so every single-page site's own generated `#about`/`#contact` nav was dead;
`stats.tsx` reset a stat to zero the instant it mounted rather than the instant it started
counting up, re-introducing the `b1d43cf` "ships zero to a real visitor" class it was
supposedly already fixed against; `stats.tsx`'s `<dt>`/`<dd>` were in the wrong DOM order
(axe); `feature-list.tsx` used `<dl>`/`<dt>`/`<dd>` for icon+title+description cards, which
isn't definition-list content and needed an illegal second `<div>` layer to lay out — now a
plain `<ul>`/`<li>`. Also fixed, found by the negative control: `generate.ts` serialized an
empty array prop as a bare `[]`, which a `const` hoist can't infer a type from — `next
build`'s TypeScript pass rejected it (`faq.items: []`, `[] as never[]` now).

**Environment finding worth keeping across sessions:** any function nested inside a
`page.evaluate` callback in this repo hits `tsx`'s esbuild-loader `__name is not defined`
bug when Playwright stringifies the callback for the browser — const-arrow and nested
`function` declarations both fail identically. The only pattern that survives: a
module-top-level named function, reconstructed inside the callback via `new Function` from
its own `.toString()`. Also: `execFile`/`execFileSync` calls a script that must talk to an
in-process HTTP server — use the async form, or the sync call blocks the event loop the
server needs to answer on (`Page.navigate` "Target closed" was this, not a Lighthouse bug).

2026-09-05, ninth pass — **deploy spec part 4 and the cloud half of part 5, both as code,
both dry-run only.** (Plan: `~/.claude/plans/aethr-product-build-spine.md` Phase 4.) The two
remaining by-hand runbooks in `SPEC.md` are now scripts; nothing has been run against the
live Cloudflare account.

- **`src/lib/cloudflare-api.ts`** (`src/lib/deploy/cloudflare-api.ts`) — a `cf<T>()` wrapper
  that takes a `fake` result per call site, so a dry-run needs no token or account and still
  exercises whatever downstream code does with the id a real call would have returned.
- **`src/lib/deploy/zone-setup.ts`** — part 4. `addZone` (`POST /zones`), `createTurnstileWidget`
  (one widget for preview + apex + `www`), `setTurnstileSecret` (`wrangler secret put`, value
  piped on stdin, never argv or a log line), `createRateLimitRule` (Rulesets API,
  `http_ratelimit` phase, 60 req/60s per IP as a starting default). Ends by printing the
  `state.md` block once — worker name, zone id, staging/production URLs — never writing it;
  `state.md` is `propose`-class, the same convention Phase 3's `analysis` line already set.
  CLI defaults to dry-run and needs `--live` to attempt a real call, opposite of `deploy.ts`'s
  own default, because this one mutates a live account on every step.
- **`src/lib/deploy/transform-rule.ts`** — the cloud half of part 5, the
  `X-Robots-Tag: noindex` rule on `aethrdesign.com`. Reads the zone's existing
  `http_response_headers_transform` rules before writing, because the Rulesets API takes the
  whole list on PUT — a bare write of just this rule would have silently deleted any other
  rule already on that phase. Idempotent by `description`; re-running after it's applied is a
  no-op, not a duplicate.
- **`run()` exported from `deploy.ts`** with a new optional `input` param (piped stdin,
  redacted in dry-run logs) — the one change to already-shipped code, needed so
  `setTurnstileSecret` doesn't duplicate the dry-run/spawnSync plumbing.
- **Verified, not assumed** (this phase's stated done-when bar):
  - End-to-end `--dry-run` for a fresh fake slug (`qa-fixture-42`) through both scripts —
    full call sequence, matching request bodies, sensible synthetic ids threaded through.
  - **`run_worker_first` scoping re-proven locally**, not inherited from the second-pass
    note: swapped `worker.ts`'s fallback for a 418, ran `wrangler dev`, confirmed `/`, an
    asset path and a missing path all still returned 200/200/404 — the Worker was never
    invoked for any of them — while `/api/contact` correctly reached it (405 for `GET`).
    `worker.ts` reverted after; `git diff` on it is empty.
  - **Drift guard re-verified by reproducing the Maxematics mutation**: recorded an approved
    manifest, then `sed`'d `noindex`→`index`, deleted a page and added a file against the
    build output — `deploy()` refused, naming exactly those three files, before touching
    `wrangler` at all.
  - `tsc` and `eslint` clean across the repo (one pre-existing unrelated warning in
    `src/lib/qa/layout-checks.ts`, not touched this pass).
- **Nothing executed live.** Every Cloudflare call in both scripts ran in dry-run only this
  pass; `--live` was never passed, and `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are
  documented in `.env.example` but unset. Zone setup and the transform rule still need a
  human, per-command yes before their first live run — this phase didn't ask for one.

2026-09-05, eighth pass — **ANALYSIS runs end to end.** `src/lib/analysis/run.ts` orchestrates
(a)→(d), writes the provenance folder, emits the REVIEW flags sheet, runs a throwaway
verification build and prints the `state.md` line without writing it. Four runs are recorded
under `Business/clients/_replay-maxematics/analysis/`: a real `claude -p` run (Opus 5, one
attempt, 290 s, build exit 0), a zero-token mock replay that reproduces its `spec.json` and
`linter-report.json` byte-for-byte, a semantic negative control, and a structural one that parks
after three attempts. Both negative-control drafts are checked-in fixtures under
`tasteled/assets/prototype/`, so any run folder can be regenerated rather than inherited.

- **Rule 7 is repaired, not blanked — and no page title is ever invented.** It is the only one of
  the eight rules a machine can fix without inventing or deleting meaning: an em dash is an AI
  tell, not an assertion, and a colon or comma in its place changes nothing the sentence claims.
  `repairPunctuation` runs before blanking, so a field whose only violation was punctuation ships
  as the model wrote it; rules 1–6 and 8 fail on claims and still blank. One draw repaired
  `pages[0].title` — "Maxematics — One-on-One Tutoring in Tampa" → "Maxematics: …" — the exact case
  that used to ship an empty `<title>`. There is deliberately **no fallback title**: a page-level
  field blanked by a claim violation stays blank and is surfaced under "Page-level fields blanked
  — needs a human" on the flags sheet, because a made-up title is the invention the floor exists
  to stop. Every repair is reported with its before and after.
- **The copy floor no longer deletes a section to protect a heading.** The consequence is scaled
  in three tiers: a blanked scalar leaves the section and renders without that field; a blanked
  required prop inside a *wholly generated* array item prunes **that item** (an item carrying the
  client's own words renders partial instead); a section is dropped only when nothing renders at
  all. On earlier draws this rule deleted `pricing` over the word "three" — taking $25/$40/$60 with
  it — then `hero` over one subheadline, then all five FAQ entries over two answers. Across three
  draws under the new rule: **zero omissions**, with the rates, the twelve topic labels and the
  surviving answers all still on the page. Rule 2 itself is untouched; only the blast radius was
  wrong.
- **Rule 6 no longer deletes a working nav link.** A real draw blanked the footer's `FAQ` label —
  an acronym in no dictionary and in no intake field — and pruned a link to a section on the same
  page. A nav label is the one generated string whose referent is provably inside the document:
  `{ label: "FAQ", href: "#faq" }` names a section that either exists in the spec or does not.
  Rule 6 alone is skipped for labels whose href resolves to an in-spec anchor or page slug; every
  other rule still applies to them.
- **A parked run keeps its evidence.** `draft-attempt-N.json` was written from the `verify` hook,
  which only sees drafts that already passed Zod — so the structural control recorded three
  failures and none of the drafts that caused them. An `onDraft` hook now writes the raw draft of
  every attempt, with `errors-attempt-N.txt` beside it.
- **`src/lib/theme/derive.ts` is now the single definition of every derived colour.** It used to
  live in three places — computed in `globals.css`, fed by `layout.tsx`, restated in
  `analysis/contrast.ts` with a comment admitting nothing caught the drift. `globals.css` now
  consumes variables and both TypeScript callers import the module.
- **Foreground polarity is derived, not fixed per role.** `primary`/`secondary` foregrounds were
  always light and `accent`'s always dark, which is right for one end of each surface's range
  and wrong for the other. Over a 3,564-point hue×saturation×lightness grid the always-light
  rule left **63%** of the space below AA and always-dark **54%**; choosing by the surface's own
  luminance leaves **11%**. `muted-foreground` went 45% → 39%, having been below AA at *every*
  hue. The residual 11% is the WCAG dead band for mid-luminance saturated colour and no
  derivation can reach it — which is why `contrast.ts` still flags and never adjusts.
- **New house fallback palette, from Untitled UI** — Gray 700 / Gray 600 / Warning 700. Six of
  six pairs pass AA, tightest 5.17:1. The old set failed three of six, on the one palette that
  ships whenever token extraction fails. `buildFallbackTokens` is exported so an offline run
  reaches it by the same path a failed extraction does, rather than carrying a second copy.
- **Two retry-loop bugs found by the negative controls.** The output guard judged *creation* of
  `draft-spec.json`, so a correct retry — which overwrites, because `errors.txt` tells the model
  to fix the file — reported "no draft-spec.json written" and parked a recoverable run. Invisible
  until now because the only real run had succeeded on attempt 1. The guard now judges presence
  against a snapshot taken once before the loop, which also closes the hole where a stray file
  written on attempt 1 was accepted on attempt 2.
- **Phase 4's assertion suite cannot be red on both negative controls, and should not try.** The
  semantic control is designed to emit a clean, buildable, structurally correct spec — every
  planted defect is repaired, blanked, pruned or reconciled away before `spec.json` exists. A
  structural suite passes it, and passing is the right answer: a red there would mean the floor
  had failed. The structural control is trivially red (no `spec.json`). Catching the semantic one
  needs a second mode, `assert.ts --expect <manifest>`, asserting each planted defect is absent
  from `spec.json` and named in `linter-report.json`. Violation count is not a quality signal —
  the real run of record blanks five fields and its spec is correct. Recorded in the plan's
  Phase 4 prompt.
- **Still open:** `globals.css`'s `:root` foreground defaults are a hand-kept copy of
  `derive.ts`'s output for the template's own primitives — Phase 4 should assert they match.
  `pages[].description` and `client.description` blank on most draws (rule 2, a count claim in a
  meta description) and ship empty; the flags sheet names them, nothing fills them.

2026-09-04, seventh pass — **the three deferred Phase 2 verifications, after `claude login`.**
All three answered, and each one moved the code.

- **CLAUDE.md contamination: `--restricted` is the entire answer, and needs no help.** With it,
  none of the discoverable instruction files load from any cwd — including one under
  `Vault/Business/clients/`. Without it, that same cwd loads all five: `~/.claude/CLAUDE.md`,
  `/Volumes/External SSD/CLAUDE.md`, `Vault/CLAUDE.md`, `Business/CLAUDE.md` and `MEMORY.md`.
  No scratch-directory gymnastics and no `--setting-sources ""` are required. The run directory
  is still a scratch dir, but for the *output contract*, not for contamination.
- **`--json-schema` works only with `$schema` removed.** Zod v4 emits
  `"$schema": "https://json-schema.org/draft/2020-12/schema"` and the CLI cannot resolve that
  ref, rejecting the whole document. `siteSpecJsonSchema()` deletes the key. Kept on as
  belt-and-braces; the Zod loop stays the oracle.
- **One real run, Opus 5, valid on attempt 1** (268 s, `--json-schema` on). The draft is checked
  in as a mock-driver fixture at `tasteled/assets/prototype/draft-spec-maxematics.json`.
- **`real-run.ts`** — the token-spending smoke test, deliberately separate from `verify-phase2.ts`
  so the default harness stays free.

End-to-end on that real draft: the rail survived generation with **zero** invented or omitted
items; the floor caught 9 violations across 7 of 86 generated fields, almost all rule-2 count
claims; contrast flagged three pairs.

2026-09-04, sixth pass — **ANALYSIS Phase 2: the model stage, the copy floor, and contrast.**
(`~/.claude/plans/aethr-build-analysis-runtime.md` Phase 2 of 4.)

- **`src/lib/analysis/generate.ts`** — stage (c). A `Driver` interface with two implementations:
  `claudeDriver` (headless `claude -p`) and `mockDriver(path)` (replays a fixed draft, so
  everything downstream is testable without tokens). Two guards: the prompt crosses the process
  boundary **on stdin**, never argv and never a shell; and the run directory is snapshotted
  before and after, with `draft-spec.json` the only permitted new file. Three attempts,
  structural failures only, `errors.txt` handed back between attempts.
- **`src/lib/analysis/reconcile.ts`** — rail overwrite, CTA hrefs, `_flags` stripping. A drafted
  rail item that matches intake is replaced verbatim; one that matches nothing is removed and
  flagged; an intake item the model omitted is listed but **not** re-inserted, because omission
  is on ruling 10's open list.
- **`src/lib/analysis/copy-floor.ts` + `words.txt`** — the eight rules over
  `generatedStringPaths()`, plus 008 §10's omission rule. Reproduces the prototype's numbers
  exactly: 0 violations on `generated-copy.json`, 19 across 9 fields on `negative-control.json`.
- **`src/lib/analysis/contrast.ts`** — WCAG over the six pairs `globals.css` derives. Flags,
  never adjusts.
- **`verify-phase2.ts`** — the harness. `npx tsx src/lib/analysis/verify-phase2.ts`.
- **Also closed three Phase 1 gaps by owner ruling:** B2's closed vocabulary is enumerated
  (twelve + `other`), C7 was added as `disclosure`'s intake source (the field set is now forty
  fields, `questionnaire-field-set.md` §13), and register selection is total and deterministic.

Phase 3 is next: the runner, provenance, the flags sheet, the verification build.

2026-09-04, fifth pass — **ANALYSIS Phase 1: the contracts, the deterministic stages, and
the prompt.** (`~/.claude/plans/aethr-build-analysis-runtime.md` Phase 1 of 4.)

- **`src/lib/analysis/intake.ts`** — the 39-field INTAKE record as Zod. Every closed
  vocabulary is a `z.enum` and a bad value is a path-addressed parse error, because a form
  control enforces it upstream. **B6 is the one exception:** out-of-vocabulary words are
  stripped and returned as a flag rather than rejected, because 007 rewrote B6's closed set
  *after* the questionnaire shipped — a record answering it with the old words is stale, not
  malformed, and parking a client over it would be wrong.
- **`src/lib/analysis/structure.ts`** — stage (b). Archetype from B2, the three default
  section orders as data, page sizing from G1, the CTA target resolver, and the list of
  section types this intake makes impossible. The skeletons are a **starting point, not a
  constraint** — ruling 10 leaves section choice and order open, and the exported type says so.
- **`src/lib/analysis/rail.ts`** — the verbatim rail as prop paths, which is what lets Phase 2
  overwrite rail fields mechanically instead of asking the prompt nicely. `classifyStringPaths`
  splits a spec three ways and `generatedStringPaths` is the copy linter's scope.
- **`src/lib/analysis/exemplars/`** — four registers captured from the live delivered sites,
  plus the `local-service` stub that stays empty by owner ruling.
- **`build-prompt.ts` + `prompt.template.md` → `prompt.md`** — a committed build artifact,
  generated and never hand-edited. Every content-bearing slot is filled verbatim from
  `productized-voice.md` or the map's ruling 10; the template's own prose covers mechanics only.
- **`verify-phase1.ts`** — the harness. `npx tsx src/lib/analysis/verify-phase1.ts`.

Phase 2 is next: the `claude -p` invocation guards, the retry loop, rail reconciliation, the
copy floor as code, and the contrast check.

2026-09-04, fourth pass — **token extraction, ANALYSIS's stage (a) and the pipeline's one
unbuilt hard dependency named in the map's "Not yet specified".** Playwright now exists in
this repo for the first time.

- **`src/lib/analysis/token-extraction.ts`** — a headless Playwright script, never an LLM.
  Loads the client's E1 reference URL, samples computed background-colour on header/nav, a
  CTA/button, and a secondary section (footer or second `<section>`), converts to HSL, and
  assigns `primary`/`accent`/`secondary`. Fonts: direct match against SPEC-FORMAT's Google
  Fonts list where the site happens to use one, else classified serif/sans off the computed
  `font-family` generic keyword and mapped to a fixed Google Fonts pair — E5 (`modern-sans` /
  `editorial-serif`) overrides this outright when the client stated a preference. `radius`
  from a button/card's computed `border-radius`, clamped 0–1.5rem. Every emitted `tokens`
  object is built through `tokensSchema.parse()` — the real validator, not a shape asserted
  by inspection.
- **Three failure classes, all routed to one fallback path, never to a model guess.**
  `navigation-timeout` / `navigation-error` (goto throws), `bot-challenge` (HTTP
  403/429/503, a challenge-page title regex, or known Cloudflare challenge selectors —
  proven against a synthetic `data:` URL carrying "Just a moment..." since no live
  Cloudflare challenge was reproducible against `portal.aethrdesign.com` today; STATE's own
  2026-09-04 migration note already found that risk zone-level and JSON-response-safe, not
  page-navigation-triggered, which this run's clean `no-brand-color-found` result against
  that same origin is consistent with), and **`no-brand-color-found`** — extraction
  succeeded (real computed styles read) but nothing on header/CTA/secondary cleared the
  neutral filter, which happened for real against `aethrdesign.com`, `nextjs.org` and
  `portal.aethrdesign.com` in verification, all legitimately low-chroma sites. On any of the
  three, tokens fall back to house neutral primary/secondary, **E3's hex when given** (else a
  fixed house gold accent), **E5's font pair when given**, fixed 0.5rem radius — and a
  `flag` naming the URL and reason for REVIEW. This is the map's hard rule: never silently
  ship a default under a promise the reference was matched.
- **Contrast data needs no separate emission.** Ticket 009 assigns the WCAG AA contrast
  assertion to ANALYSIS, and `layout.tsx`'s existing neutral-scale derivation
  (`--background: hsl(primary-h, 10%, 98%)`, button foreground `hsl(h, s, 98%)` against
  `hsl(h, s, l)`) means the emitted `primaryLightness`/`accentLightness` and their
  saturations already carry everything a downstream contrast check needs — the pale-grey-
  on-white failure case shows up directly in `accentLightness` approaching 98%. Nothing
  extra to build here.
- **`tokensSchema` exported from `site-spec.ts`** (was module-private) — the one edit to
  shipped P5–P7 code, needed so extraction and its verification script can validate against
  the real schema rather than a hand-copied duplicate.

Verified: `tsc` and `eslint` clean across the repo. Ran against three real origins per the
brief — `mailchimp.com` (**extracted**: real gold/yellow hue, serif heading detected and
mapped to Playfair Display/Lora), `portal.aethrdesign.com` (**Cloudflare-fronted**,
navigated clean, fell back on `no-brand-color-found`), and a nonexistent domain (**fails
outright**, `navigation-error`, `net::ERR_NAME_NOT_RESOLVED`) — plus a synthetic `data:` URL
to prove the `bot-challenge` branch specifically. All three real-origin outputs, plus the
synthetic one, were parsed through the actual `tokensSchema` and through a full `SiteSpec`
built with the emitted tokens plugged in, against the actual `siteSpecSchema` — not by
inspection.

2026-09-04, third pass — **the base template tail: the last two section types, and the
client-side Turnstile widget.** Both items the previous pass left open are closed.

- **`credentials` and `disclosure` shipped, and the palette is fourteen.** `credentials` is
  a plate grid of licences, registrations and memberships, each with an optional link to the
  issuer's own public register; `disclosure` is regulatory fine print in two variants —
  `fineprint` (the quiet block above the footer) and `panel` (the bordered treatment for a
  disclosure that has to be read, e.g. under a pricing table). Both are industry-neutral per
  014: there is no finance component.
- Each ships with its Zod schema, its arm of the discriminated union, its registry entry and
  its conformance assertion. `resolveIcon` gained an optional `fallback` so `credentials`
  falls back to `BadgeCheck` rather than the shared `Sparkles`; `Award` and `BadgeCheck`
  joined `ICON_MAP`.
- **The Turnstile widget shipped** — `src/components/ui/turnstile.tsx`, wired into
  `contact.tsx`. `TURNSTILE_SECRET_KEY` is no longer blocked: set the site key at BUILD and
  the secret on the Worker together.
- **The two stale ten-of-fourteen surfaces were completed rather than deleted** (owner call).
  `src/lib/types.ts` now carries all fourteen and, more usefully, a `SectionPropsByType` map
  keyed on `SectionType` that makes a missing row a `tsc` error — it had rotted silently for
  two batches precisely because nothing imports it. `src/app/showcase/page.tsx` renders all
  fourteen in a realistic page order.
- Count corrected from twelve to fourteen on every live surface — `SPEC-FORMAT.md`,
  `Business/core/productized-tier-scope.md` (§ palette, § archetypes, §8),
  `Business/CLAUDE.md`, and `go-to-market-plan.md`'s Track A. Closed tickets were left alone
  as historical record.

Verified: `tsc` and `eslint` clean; the conformance guard negative-controlled on all three
drift modes for both new types plus the registry-closure guard; five hand-built bad specs
each fail with a path-addressed message; all four sample specs parse; the now-fourteen-section
fixture assembles and completes `next build`; the showcase route builds and its four new
sections are present in `out/showcase.html`; and the built static export was served and
driven in a browser — the widget renders, issues a token, that token reaches the
`/api/contact` payload, and the widget remounts clean after a successful send.

2026-09-04, second pass — **the static export and the deploy path**, the item the map
ordered *before* ANALYSIS because it touches this same shipped P5–P7 code.

- `next.config.ts` — `output: "export"` + `images: { unoptimized: true }`. `next build`
  emits 54 static files, 1.8 MB, no server. This is what keeps client traffic off
  Cloudflare's account-wide 100,000-requests/day Worker cap, which is shared with the
  portal, checkout and the apex proxy.
- `src/app/api/contact/route.ts` **deleted**, reborn as `src/worker.ts` — the one dynamic
  route, reached by `run_worker_first: ["/api/contact"]`. `contact.tsx` untouched.
- `src/lib/deploy/wrangler-config.ts` — per-client config generator, slug validation,
  reserved-slug list.
- `src/lib/deploy/artifact.ts` — the artifact manifest (per-file sha256 + tree hash).
- `src/lib/deploy/deploy.ts` — `staging` / `deploy` / `rollback` CLI, all `--dry-run`able.
- `src/lib/deploy/SPEC.md` — implementation notes, promoted from the wayfinder asset as
  that spec said it would be. Carries the two by-hand runbooks.
- `wrangler` added as a devDependency; `workerd` build approved in `pnpm-workspace.yaml`.
- Sibling repo: `aethrdesign-proxy/safe-deploy.sh` (`npm run deploy:safe`) makes
  `verify.sh` an unskippable pre-deploy gate on the apex Worker.

Earlier the same day — **the section prop schemas**, the precondition for ANALYSIS. The
palette went from ten section types to twelve, and `SiteSpec` went from validating site
*shape* to validating section *content shape*. See `src/lib/assembly/section-props.ts`,
`section-props.conformance.ts`, `sections/pricing.tsx`, `sections/feature-list.tsx`,
`sections/icon-map.ts`, `sample-specs/_all-sections.json`.

### Mechanical cleanups — 2026-09-04

Three syntax/stale-file fixes, no design decisions:

1. **`src/lib/types.ts` — complete.** Already carried all fourteen section types and `SectionPropsByType` coverage guard (second pass).
2. **`src/app/showcase/page.tsx` — complete.** Already renders all fourteen sections (second pass).
3. **Artifact manifest write path moved to Vault.** `.deploy/` is gone; `manifestPath()` now writes to `/Volumes/External SSD/Vault/Business/clients/<slug>/approved-artifact.json`. Added `--vault-root` CLI flag (defaults to that path). `SPEC.md` updated; no API changes to callers outside this module. Verified: `tsc` clean, `eslint` clean, `pnpm build` completes, dry-run resolves path correctly.

### Eleventh pass — the Maxematics replay (Phase 5). PASSED, after five defects it found.

Phase 5 of `~/.claude/plans/aethr-product-build-spine.md`, 2026-09-06, run as an acceptance
test of the whole pipeline rather than as a build task. It **parked twice before passing**,
and the two parks are the useful part of this entry: everything below was found by pointing
the finished pipeline at a real engagement, and none of it was visible from unit-level work.

Final run: `Business/clients/_replay-maxematics/analysis/2026-09-06T22-44-02.255Z`
(`spec.json` + the REVIEW-approved `spec-approved.json`). QA: `qa-verification/replay-phase5/`.

INTAKE → ANALYSIS (`claude -p`, Opus 5, one attempt, real token extraction) → REVIEW → BUILD
→ QA **STAGED, 0 blockers** → STAGING dry-run clean (56 files, 2.00 MB, artifact `c295deb36a13`).
`assert.ts` 13/13. Nothing run against the live Cloudflare account.

### The five defects

1. **`htmlToText` did not decode `&#x27;`** — the form React SSR emits for an apostrophe.
   Check 1 diffs raw SSR HTML against the hydrated DOM, so **any client whose copy contained
   an apostrophe parked**. The decoder enumerated named and decimal entities and missed the
   hex form. Now decoded by form, any code point.

2. **The positive control could not fail.** It passed only because none of its copy had an
   apostrophe. A fixture covers the characters its client happened to write and nothing else,
   so `verify-qa.ts` now also checks `htmlToText` against a 14-case escape table — verified
   red when the bug is reintroduced.

3. **Every generated site shipped two footers.** `layout.tsx` renders one from `clientConfig`
   on every route, and `footer` was in all three archetype skeletons. `SPEC-FORMAT.md` had
   documented the conflict; nothing enforced it. **Removing it from the skeletons was not
   enough** — the next run added `footer` back on its own, which is ruling 10's open hand
   working exactly as designed. It took all three layers: skeleton stops suggesting it,
   `prompt.template.md` states the layout already renders one, QA's check 8 blocks a page
   with more than one `<header>`/`<footer>`.

4. **Layout assertions and screenshots ran against the unsettled page.** The first replay
   screenshot showed an invisible hero headline and three empty sections on a site rendering
   perfectly — the artifact REVIEW looks at, lying about the build — and every
   `getBoundingClientRect()` assertion was measuring elements still offset by their enter
   transform.

5. **Settling on `document.getAnimations()` was not enough.** The screenshot then caught the
   count-ups mid-flight: **"11 Topics", "9+ Weekly students", "1792 Tutoring since"** against
   intake values of 12, 10+ and 2022 — numbers in no client record, on the artifact REVIEW is
   meant to trust. `framer-motion` drives counters through rAF, which never registers a WAAPI
   `Animation`. `settle.ts` now waits on **rendered-text stability**.

### Decisions worth not re-making

- **This repo is consumed as SOURCE by `aethr-portal`, not as a package.** Its
  `scripts/sync-template.mjs` mirrors `src/lib/{assembly,edit,theme}`, `src/lib/utils.ts`
  and `src/components/{sections,ui,layout}` into its own tree on every build. Two
  consequences that matter here: **the section, ui and layout components must not reintroduce
  `@/` imports** (they would resolve against the portal's `src/`), and a new file those
  components import needs a row in that script's `MIRRORED` list or the portal build fails.
  `assemble.ts` and `generate.ts` are deliberately excluded — they read the filesystem and
  belong to the build.
- **`src/lib/edit/preview.tsx` is not re-exported from `edit/index.ts`.** It pulls in
  fourteen components behind a `"use client"` boundary; a server route importing the
  partition would otherwise drag the whole section tree into a server bundle.

- **A skeleton cannot enforce anything — it is a suggestion, and the model overrides it.**
  This is the single most transferable lesson of the phase. Removing `footer` from the
  skeletons looked like the fix and was not: the very next run put it back, correctly, under
  the open hand. Any structural constraint has to either reach the model as a stated fact
  about the rendering environment, or be caught downstream by a check. Preferably both.
- **A structural fact is not a content rule, and belongs in the template rather than the
  voice doc.** "Do not emit a `footer`; the layout renders one" constrains shape, not what
  the copy says, so it does not breach ruling 10 or the "copy rules live in
  `productized-voice.md`" guard. Prompt generation re-verified idempotent by hash.
- **Rule 2 fires hard on this intake and thins the site.** Run 3 blanked `hero.subheadline`,
  `about.story` and `services.heading` — all for stating "twelve", which is true and is a
  count equal to a spec array length. The client genuinely has twelve topics and any natural
  sentence says so. The floor is behaving as specified; the consequence is that a hero can
  ship with no subheadline. Worth a look before this meets a paying client, but it is a
  ruling, not a bug, so it was left alone.
- **REVIEW fills only the page-level blanks.** The flags sheet marks exactly those as
  "needs a human"; section props the floor blanked ship blank, because the section renders
  without them and filling them is the copy-polish pass 007 removed. An earlier pass in this
  session filled a `services` heading too — that was overreach and is corrected.
- **The replay writes to `_replay-maxematics`, never `max-maxematics`.** Two run folders under
  one client IS 019's rejection record and Phase 6 will read it as one; replay runs are not
  rejections, and the real client folder is a business record. Phase 6's read surface must
  exclude `_`-prefixed client directories. Note the tension: `validateSlug` rejects a leading
  underscore, so a replay client can never be staged under its own folder name — the STAGING
  dry-run used `--vault-root /tmp/replay-vault` with slug `replay-maxematics`.
- **A missing Playwright browser binary throws out of ANALYSIS rather than falling back.**
  The Phase 1 install no longer satisfied the pinned revision (`chromium_headless_shell-1234`).
  Defensible — an uninstalled browser is an install fault, not an unreadable client site — but
  it left a partial run folder that must not be read as a rejection either.
- **Contrast passes 6/6 on the E3-seeded fallback palette**, `accent/accent-foreground` at
  5.29:1. The tenth pass recorded that same pair at 3.23:1 on "the Maxematics purple". The two
  measurements disagree and this pass did not chase it. Do not treat either as settled.

### Known gaps, deliberately not fixed here

- **Token extraction still falls back on the replay's own reference site.**
  `https://edufor.framer.wiki/` yields `no-brand-color-found`, so the replay themes on E3 plus
  house defaults and flags it. Correct behaviour; it also means the replay does not exercise a
  successful extraction end to end.
- **Icons are the generic fallback glyph** across `feature-list`, `services` and `credentials`
  — twelve subject cards carrying one placeholder mark. Reads unfinished. A taste call on
  `icon-map.ts`, not a defect.

---

### Fourteenth pass — the first live DEPLOY, and the defect it exposed. 2026-09-09.

`deploy.ts deploy` and `zone-setup.ts` steps 2–3 ran against the real Cloudflare account for
the first time. All of it worked. The valuable part is what the working version then revealed.

**Target was `replay-maxematics-live.aethrdesign.com`, not `maxematics.org`.** The client's
zone is not on this account — nameservers are Namecheap's, A records point at GitHub Pages,
and `state.md` already carries the ruling that its DNS is client-managed. `deploy` attaches
Worker Custom Domains, which requires the zone in-account, so the client's apex was never a
candidate. Owner elected an AethrDesign-owned host. Client production and staging were probed
read-only and never written to.

Live: version `ceb49bd9`, artifact `5521a1b30f36` (56 files / 2.01 MB), 200, brand token
`--primary-h:262.5` in the document, eleven section anchors, `/api/contact` 405.

### The defect: STAGING detaches production routes

`routesFor()` returns only the preview hostname at stage `staging`, and `wrangler deploy`
reconciles Custom Domains to the config it is given. **A re-stage after DEPLOY removes the
client's apex and `www`, deletes their DNS records, and exits 0.** Measured deliberately:
three domains attached / apex 200 → one `staging` run → one domain / apex **522**, no warning.

The preview URL serves 200 throughout. That is why it is dangerous — the surface an operator
checks first stays green while the client's own domain is down. It cost a full deploy cycle
earlier the same day before it was understood: a concurrent session's staging run silently
undid a completed production deploy, and the first diagnosis (a certificate failure) was wrong.

**The documented recovery path is the trigger.** Spine Phase 0 item 3 says "keep re-staging
working as the recovery path"; for a client past DEPLOY that is the outage. Ticket
`Business/tasteled/tickets/027-staging-detaches-production-routes.md` carries the two candidate
fixes. Nothing is implemented here — the fix is a ruling, not a cleanup.

### Decisions worth not re-making

- **This repo is consumed as SOURCE by `aethr-portal`, not as a package.** Its
  `scripts/sync-template.mjs` mirrors `src/lib/{assembly,edit,theme}`, `src/lib/utils.ts`
  and `src/components/{sections,ui,layout}` into its own tree on every build. Two
  consequences that matter here: **the section, ui and layout components must not reintroduce
  `@/` imports** (they would resolve against the portal's `src/`), and a new file those
  components import needs a row in that script's `MIRRORED` list or the portal build fails.
  `assemble.ts` and `generate.ts` are deliberately excluded — they read the filesystem and
  belong to the build.
- **`src/lib/edit/preview.tsx` is not re-exported from `edit/index.ts`.** It pulls in
  fourteen components behind a `"use client"` boundary; a server route importing the
  partition would otherwise drag the whole section tree into a server bundle.

- **`deploy()` trusting wrangler's exit code is not enough.** The deploy spec already names
  this failure class for a different call — the failure happens after the upload and looks like
  success. DEPLOY has the same shape with no guard. The drift guard protects the bytes; nothing
  protects the routes.
- **A 4-label host gets no working certificate, and that settles an open question.**
  `www.replay-maxematics-live.aethrdesign.com` attaches and even gets a `cert_id`, but TLS
  returns `no peer certificate available` — Universal SSL covers the apex and one wildcard
  level. This is the "probably fine, unverified" note under `previewHostname`, now verified as
  *not* fine. **It does not affect a real client** (their `www.<apex>` is three labels), but it
  means a subdomain can never be a complete DEPLOY rehearsal. A true apex test needs a
  throwaway domain, which would also be the only way to exercise `zone-setup` step 1.
- **"Both or neither" is enforced by nothing.** With `TURNSTILE_SECRET_KEY` on the Worker and a
  build carrying no `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, every submission 403s. Measured, then
  reverted by deleting the secret. The two halves are set in different stages by different
  commands and no check compares them.
- **Never run two sessions against this repo at once.** One Worker, one working tree, one
  `wrangler.jsonc`, one `out/`. A concurrent session overwrote this one's work four times, and
  once published the default `Client Name` template to the shared preview host because its
  self-edit undo had reverted `src/app/page.tsx` while a build was queued behind it. Caught by
  the APPROVE check within the minute, but nothing structural prevented it.
- **The APPROVE check earns its place.** Comparing title and byte count against expectation is
  what caught the wrong-site publish. A staging run that exits 0 says nothing about *which*
  site got staged.

### Known gaps, deliberately not closed here

- `zone-setup` step 1 (`addZone`) and step 4 (`createRateLimitRule`) have still never run live.
  Step 1 needs a domain not already on the account; step 4's PUT replaces the `http_ratelimit`
  entrypoint on a zone shared with the portal, checkout and every preview host.
- The proof host carries a second, hand-written `noindex` transform rule, because the part-5
  suffix rule matches only `-preview.`. Remove it when the host is retired.
- `Business/clients/replay-maxematics/` exists at the real-client path, holding only an
  `approved-artifact.json` written when a run omitted `--vault-root`. SPEC says the manifest
  belongs under the `_replay-maxematics` fixture root. Harmless (no `state.md`, so the portal
  scraper ignores it) but it is the thing SPEC explicitly wanted avoided.

### Sibling defect found while closing out: STAGING builds without assembling

`staging()` runs `next build` and never runs `assembleFromSpec`. The generated sources
(`src/app/page.tsx`, `src/lib/client-config.ts`) are ordinary tracked files that any other
operation can leave in any state, so **STAGING is only correct if a human remembered to assemble
first.**

Verified at the end of this session: `out/` holds the live Maxematics artifact `5521a1b30f36`,
while `src/lib/client-config.ts` reads `name: "Client Name"` and `src/app/page.tsx` carries zero
occurrences of "Maxematics". The working tree does not reproduce what is deployed. A bare
`pnpm build` right now would overwrite `out/` with the default template and the next `staging`
would publish it.

That is not hypothetical — it happened earlier the same day (`logs/02-staging-live.log`): a
staging run shipped the `Client Name` template to the client-facing preview host, because a
concurrent session's self-edit undo had reverted `page.tsx` while a build was queued behind it.
It was caught only because the APPROVE check compares title and byte count, not because anything
in the pipeline noticed.

Two things follow. **`staging()` should assemble from the approved spec as its first step**, so
the build cannot be a function of whatever happens to be in the tree. And **the spec that a
staged artifact was built from should be recorded in the manifest** — `approved-artifact.json`
pins the output bytes but says nothing about the input, so a wrong-site publish is invisible to
the drift guard, which correctly reports a clean match for a perfectly-built wrong site.

Not ticketed here; it belongs with 027 as the same family — the pipeline trusting ambient state
it does not control. Raise as its own ticket rather than folding it into 027, whose question is
narrower.

## Deploy verification snapshots

Moved from `src/lib/deploy/SPEC.md` on 2026-09-18 — point-in-time evidence, not current state.

**Live status, 2026-09-08.** `transform-rule.ts apply --live` is on the zone.
`deploy.ts staging` (no `--dry-run` — this CLI is live by default; there is no `--live`
flag) has now run for real: Worker `site-replay-maxematics`, version
`e612399d-d38a-401a-8747-f36e8831def9`, serving
https://replay-maxematics-preview.aethrdesign.com (Maxematics v1 replay,
`spec-approved.json` from `_replay-maxematics/analysis/2026-09-06T22-44-02.255Z`, artifact
`0ad68a8cb53a`, 56 files / 2.00 MB). Live `GET /` is 200 with the replay headline;
`X-Robots-Tag: noindex, nofollow` is on the response (the zone transform rule);
`GET /api/contact` is 405 / `Allow: POST`. Drift guard re-exercised against that recorded
manifest: `index.html` mutated, `showcase.html` deleted, `injected-after-approve.txt` added
— `deploy` refused with those three names and never called wrangler. Manifest lives under
the fixture vault-root
`Business/clients/_replay-maxematics/Business/clients/replay-maxematics/approved-artifact.json`
so a `replay-maxematics` folder is not created next to real clients (underscore slug is
illegal, and a bare `replay-maxematics/` would be scraped as a client).
