# QA suite — implementation notes

Companion to the decision record at `Vault/Business/tasteled/assets/qa-specification.md`,
which stays the spec of record and carries the *why* (same split `deploy/SPEC.md` uses for
the deploy item). This file covers what is built, how to run it, and deviations from the
spec discovered while building it.

Built 2026-09-05, plan `~/.claude/plans/aethr-product-build-spine.md` Phase 3.

---

## What's here

| Module | Spec section | What it does |
|---|---|---|
| `content-checks.ts` | §5.1, checks 1–8 | Per-page content checks. Generic ones (1 server-vs-hydrated, 3 placeholders, 4 links, 5 contact identity, 7 images, 8 title/meta/h1) are `tasteled-qa`'s; spec-driven ones stay here (2 number-vs-count, 6 empty section) plus two stricter-than-public checks (`blank-alt-text`, `landmark-count`) |
| `types.ts` | §3 | PARKED/STAGED/PASS, and the seam with `tasteled-qa`: `fromShared` (which of its warnings are blockers here) and `toShared` (for its report renderer) |
| `browser-context.ts` | — | The check context, with the `__name` shim `tsx` needs to run `tasteled-qa`'s `page.evaluate` callbacks |
| `asset-check.ts` | §7 | Raster-asset-in-`out/` vs optimization-manifest coverage |
| `smoke.ts` | §2 | The 5-check post-push smoke suite against a deployed URL |
| `image-pipeline/optimize-images.ts` | §6 | sharp + ImageOptim + SHA-256 manifest; the one copy, also run by `tasteled` and `portfolio-2026` |
| `image-pipeline/prewarm.ts` | §6.5 | Cloudflare-cache prewarm, rewritten (not ported) — see deviation |
| `run.ts` | §8 | Orchestrator. CLI: `npx tsx src/lib/qa/run.ts --spec <path> [--check content\|layout\|a11y\|asset\|all] [--skip-build] [--skip-assemble]` |
| `verify-qa.ts` | §10 | The two controls, run end to end: `npx tsx src/lib/qa/verify-qa.ts` |

**From `tasteled-qa` (devDependency, public MIT — ticket 032):** layout assertions + screenshots
at 390/768/1440/1920 (§5.2), axe-core + Lighthouse (§4), settling, the static server, and the
report (`report.html` + `report.json`). Until 2026-09-28 this repo carried its own copies; they
had already drifted — the public package had fixed wrapped-link overlap and external 403/429
false positives that this suite still reported. **A fix to a generic check lands in
`tasteled-qa`, gets published, and reaches this suite by bumping the version** — never by
patching a local copy back in. Consolidating surfaced one real defect: axe used to run before
the page settled, so every scroll-revealed section was invisible to it; the first settled run
caught the CTA band's eyebrow failing contrast (fixed in `cta-band.tsx`). Lighthouse
performance is now recorded as evidence rather than an advisory finding, so a clean site can
reach PASS instead of always stopping at STAGED.

Every check module exports its individual check functions directly (e.g.
`checkNumberVsDomCount`, or `checkPlaceholders` and `runAxe` from `tasteled-qa`) — "every check must be individually
runnable" is satisfied at the function level, not by a separate CLI per check.

## Controls

- **Negative control** — `fixtures/negative-control.json` (+ `fixtures/negative-control.jpg`,
  staged into `public/qa-fixtures/` only for the run). Must PARK. Verified to trip: checks
  2, 3, 4, 5, 6, 7, 8, and the asset-manifest check.
- **Positive control** — `fixtures/maxematics-v1.json`: the real ANALYSIS output for the
  Maxematics replay (`Business/clients/_replay-maxematics/analysis/2026-09-05T15-45-42.528Z/spec.json`),
  with the two REVIEW-flagged blanks (`client.description`, `pages[0].description`) filled
  the way a human would at REVIEW before BUILD ever runs. Must not PARK (STAGED or PASS both
  count — performance has no threshold anywhere, §6, so its advisory is expected and not a
  failure condition).

Run both: `npx tsx src/lib/qa/verify-qa.ts`.

## Deviations from the spec, and why

1. **`next start` doesn't run against `output: "export"`.** §2 says "local production build
   (`next build && next start`)" — written before the static-export decision landed.
   `static-server.ts` is the minimal stand-in: no new dependency, matches Cloudflare's own
   `/foo` → `foo.html` routing.
2. **Lighthouse runs on the homepage only, not every page.** §4 doesn't scope it, but its own
   reasoning for the accessibility=100 threshold — "the component palette is closed and
   identical across every client, a defect in it is a template regression to be found once"
   — applies equally to which pages need a Lighthouse pass. axe-core still runs on every page.
3. **The Lighthouse call is a plain-Node child process (`lighthouse-runner.mjs`), not called
   in-process.** Two independent bugs, both real, both found by trying the straightforward
   approach first:
   - `tsx`'s esbuild-based loader breaks Lighthouse's own page-injected code (`ReferenceError:
     __name is not defined` inside `_lighthouse-eval.js`). Isolating the `lighthouse()` call
     in an unmodified Node process sidesteps it. **The same failure recurs for any function
     nested inside a `page.evaluate` callback in this repo, not just Lighthouse's own code**
     — `layout-checks.ts`'s `evaluateLayout` hit it twice (a `const`-arrow helper and a
     nested `function` declaration both failed identically) before landing on the only
     pattern that survives stringify-and-run-in-browser: a plain, module-top-level named
     function, reconstructed inside the callback via `new Function` from its own
     `.toString()`, never a helper defined inside the callback itself.
   - The child spawn **must be async** (`execFile`, not `execFileSync`): the target page is
     served by an in-process static server, and a sync spawn blocks this process's event
     loop until the child exits, so the server can never answer the child's navigation
     request. Manifested as `Page.navigate` "Target closed" — confirmed by elimination
     (the same call against an external URL, unaffected by this process's event loop,
     always succeeded).
4. **`optimize-images.ts` needed no Cloudflare-specific adaptation; `prewarm.ts` needed a
   full rewrite, for the opposite of the reason expected.** `deploy/SPEC.md` flagged "`next/
   image` needs a custom loader under OpenNext on Cloudflare Workers" as an unresolved edge.
   The static-export decision made it moot rather than resolving it: `next.config.ts` sets
   `images: { unoptimized: true }` and every section renders a plain `<img>` — there is no
   `/_next/image` endpoint in this template at all. `optimize-images.ts` operates on
   `public/` before the build either way, so it ported directly. `prewarm.ts` targeted that
   nonexistent endpoint in the source script, so its replacement warms Cloudflare's own edge
   cache for the plain `<img src>` URLs a page actually renders, walking the site's own known
   routes (`spec.json`'s pages) rather than a sitemap the template doesn't emit.
5. **Content-sanity check 2 (number-vs-DOM count) is scoped to page `<title>`/meta
   description, not full-page prose-mining.** The ticket's anchor case ("14 topics" vs an
   actual count of 12) and the resolution's own wording ("covers the meta description") both
   point at this surface specifically. A generic scan for any digit near any noun across all
   generated copy has no reliable way to know which list a given number claims to describe
   without inventing NLP the spec never asked for, and risks drowning in false positives
   (prices, years, phone numbers). Widening this is a real option if a future defect shows
   up outside title/description — flagged here rather than guessed at.

## Template regressions this suite found and fixed while verifying against Maxematics v1

Per §4's own logic — a defect in the closed, shared component palette is "a template
regression to be found once," not a per-client tolerance — three were found and fixed
directly rather than left for a follow-up ticket, since the positive control needing to
pass clean is what surfaced them in the first place:

- **`generate.ts` didn't emit a per-section anchor id.** A single-page site's own generated
  footer/CTA hrefs (`#about`, `#contact`, ...) are section type names, but no section ever
  rendered a matching `id` — every anchor on every single-page build was dead. Fixed by
  wrapping each generated section in `<div id={section.type}>`.
- **`stats.tsx` reset a stat to "0" the instant it mounted, not the instant it started
  animating.** Below-the-fold stats flashed zero to any real visitor before they ever
  scrolled to them — the same failure class as the `b1d43cf` "stop shipping every stat to
  crawlers as zero" bug this check was named for, reintroduced by an over-eager `useEffect`.
  Fixed by moving the zero-reset to immediately before `animate()` starts, guarded by the
  same `isInView` check.
- **`stats.tsx`'s `<dt>`/`<dd>` were in the wrong DOM order** (value before label) — axe's
  dl/dt/dd ordering rule. Fixed by swapping the markup order and keeping the visual order
  (value above label) via `flex-col-reverse`.
- **`feature-list.tsx` used `<dl>`/`<dt>`/`<dd>` for icon+title+description cards**, which
  isn't term/definition content and needed a second `<div>` layer (for the icon) between
  `<dl>` and its `dt`/`dd` — HTML5 permits exactly one `<div>` wrapping layer under `<dl>`,
  never two. Fixed by switching to a plain `<ul>`/`<li>` list — the correct semantic element
  for this content in the first place.

Also fixed, found by the negative control rather than the positive one: `assembly/
generate.ts` serialized an empty array prop (e.g. `faq.items: []`) as a bare `[]`, which
`next build`'s TypeScript pass rejects as implicitly `any[]` once hoisted into its own
`const`. Fixed by emitting `[] as never[]`.

## Five defects the Phase 5 Maxematics replay found (2026-09-06)

1. **`htmlToText` did not decode `&#x27;`** — the form React's SSR emits for an apostrophe.
   Check 1 compares raw SSR HTML against the hydrated DOM, the DOM side always has the
   decoded character, so **any client whose copy contains an apostrophe parked**. The decoder
   enumerated named and decimal entities and missed the hex form entirely. Now decoded by
   *form* (`&#x…;` and `&#…;`, any code point) rather than from a list, with the named set
   applied after and `&amp;` last so a double-encoded `&amp;lt;` does not collapse.

2. **The positive control could not fail.** `fixtures/maxematics-v1.json` passed only because
   none of its copy contained an apostrophe. Replaced with the Phase 5 acceptance run's
   REVIEW-approved spec, which carries "USF's" and "Founder & tutor". A fixture only covers
   the characters its client happened to write, so `verify-qa.ts` also checks `htmlToText`
   directly against a 14-case escape table — verified to go red when the bug is reintroduced.

3. **Every generated site shipped two footers.** `layout.tsx` renders one from `clientConfig`
   on every route and `footer` was in all three archetype skeletons, so the spec added a
   second inline. `SPEC-FORMAT.md` had documented the conflict; nothing enforced it. Check 8
   now blocks a page with more than one `<header>` or `<footer>` landmark, and the skeletons
   no longer list `footer`. The suite had no landmark-uniqueness assertion at all before this
   — check 8 counted `<h1>` and stopped.

4. **Layout assertions and screenshots ran against the unsettled page.** The sections reveal
   on scroll (`whileInView`/`useInView` in `stats`, `testimonials`, `cta-band`), so a capture
   taken straight after `load` photographed an invisible hero headline and three empty
   sections on a site that rendered perfectly — and every `getBoundingClientRect()` assertion
   measured elements still offset by their enter transform. Fixed by `settle.ts`, now run
   before both the layout stage and the content stage.

5. **Settling on `document.getAnimations()` was not enough.** With reveals fixed, the
   screenshot still caught the count-ups mid-flight, reading **"11 Topics", "9+ Weekly
   students", "1792 Tutoring since"** against intake values of 12, 10+ and 2022 — three
   numbers that appear in no client record, on the artifact REVIEW is meant to trust.
   `framer-motion` drives numeric counters through `requestAnimationFrame`, which never
   registers a WAAPI `Animation`. The settle condition is now **rendered-text stability**
   (three identical `innerText` samples, 8s bound), which is mechanism-agnostic and covers
   counters, typewriters and staggered reveals without knowing how any of them work.

   This one also removes a latent false positive in check 1: a counter caught mid-flight
   makes the hydrated DOM differ from the SSR HTML, and check 1 would have called that a
   hydration mismatch. It passed until now only because the stats sit below the fold and had
   not started animating when the check ran.

**The pattern in all five: a guard that cannot fail is not a guard.** Negative-control every
check in this suite by reintroducing the defect and watching it go red, the way the
conformance and coverage guards in `assembly/` are.

## Two check-implementation bugs found and fixed during verification

Both surfaced as false positives against the *real* Maxematics v1 build, not against the
negative control — worth naming since a future session might otherwise "fix" the template
instead of the check:

- **Check 1 compared the full document against body-only content.** The raw SSR fetch is
  the whole HTML document (`<title>` included); `document.body.innerHTML` is body-only.
  Every page failed on that mismatch alone. Fixed by extracting `<body>...</body>` from the
  raw HTML before comparing.
- **The layout clipped-text check flagged every `sr-only` element.** A visually-hidden-but-
  accessible element (Tailwind's `sr-only`: `position: absolute`, 1×1px, `overflow: hidden`)
  is *indistinguishable* from real clipping by box dimensions alone — it's deliberately a 1px
  box hiding real text for screen readers. Fixed by recognizing that exact signature and
  excluding it, rather than by class name (so a non-Tailwind equivalent is still caught).

## Not built here

- The email-on-PARK notification (`resend`) — §3's blocker behavior names it, but wiring a
  real client's park event into the pipeline is BUILD/deploy-orchestration work, not part of
  the suite itself.
- The `state.md` Stage Log append on a real client run — same reasoning; this suite reports
  a verdict, the pipeline orchestrator (not built yet, see the plan's Phase 4/5) is what owns
  writing it to a specific client's `state.md`.
- ImageOptim.app verification against a real running instance — `optimize-images.ts` is
  ported faithfully (same osascript queue-polling approach as `portfolio-2026`) but only
  exercised here against zero-raster-asset fixtures, since neither control spec references
  a raster image path that needs real optimization.
