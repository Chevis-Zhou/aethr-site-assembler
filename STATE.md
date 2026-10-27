---
updated: 2026-10-12
status: active
---
# AethrDesign Next.js base template + assembly system — state

## Where we left off

**2026-10-12 — Shared native-bundle adapters committed and pushed (`b69569a`); Phase5 development acceptance DONE.** Five generic annotation modules now consume the existing integrity-locked shared package; dev/watch also sync before imports. This clears native inventory/edit/restore/upload/publish regressions in downstream clean-source CI. No client configuration, private analysis, new dependency or transport-lock change. Base102 tests/typecheck/scoped lint PASS; downstream native/legacy52 and full clean consumer779 pass/5 expected skips, lint/typecheck/agent/audit PASS. Historical single-page HTML behavior and assembled editing stay covered.

**Release boundary:** production is NOT deployed by this phase. Exact external runtime/target/media/handover acceptance remains release work; Phase4 workload/CPU/memory/artifact gates stay deferred before client CMS activation. The primary checkout remains at its older local baseline with existing mixed work intact; scoped source was published from the existing isolated worktree. Do not reset or stage the primary tree wholesale.

_Keep only the newest entry here. When adding one, move the previous entry to the top of [`docs/state-history.md`](docs/state-history.md) — history there, current state here._

## Open threads

- **Shared image optimizer extended for portfolio-2026, 2026-10-07; committed, not pushed.** `src/lib/qa/image-pipeline/optimize-images.ts` is now the one copy portfolio-2026 also runs: bounded budgets, `sharpGuard`, explicit files, exclude. The Linux `jpegtran` pass now uses `-copy icc`. It was `-copy none`, which dropped the JPEG ICC profile. Next: push when Chevis approves.

- **Turnstile is now enabled in pairs, and the pairing is the whole rule.**
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is a BUILD input inlined into the static export;
  `TURNSTILE_SECRET_KEY` is a Worker secret. Neither set → no widget, no token, Worker
  accepts (the shipped pre-Turnstile behaviour). Both set → protected. **Secret only → every
  legitimate submission is still rejected**, which is the same trap as before, just now
  avoidable. Because the site key enters at BUILD, a client whose Turnstile widget is created
  after their site was built has to be rebuilt and re-staged.
- **Nothing has been executed against the live Cloudflare account.** Per-client zone setup
  and the `X-Robots-Tag` Transform Rule on `aethrdesign.com` are now code
  (`src/lib/deploy/zone-setup.ts`, `src/lib/deploy/transform-rule.ts`, ninth pass) rather
  than by-hand runbooks, but both still default to dry-run and neither has been run with
  `--live`.
- **The approved-artifact manifest lives only on this Mac.** `.deploy/` is gitignored; it
  belongs beside `spec.json` in the Vault client folder. Until then, re-staging is the
  recovery path.
- **Then ANALYSIS.** Both of its stated preconditions are now met, and token extraction —
  the one hard dependency named in the map's "Not yet specified" — is now built. What
  remains of ANALYSIS is the orchestrator: the four-stage pipeline, the `claude -p` copy
  generation stage, the retry policy, and the REVIEW artifacts. None of that was touched
  this pass — see the new "shared Playwright install" decision below before starting the
  QA suite, which is the other consumer of this same install.

- **`--permission-mode dontAsk` alone silently denies Write, and it would have broken every
  unattended run.** `--tools Read,Write` makes the tool *available*; it does not make it
  *permitted*. The run reports success, writes nothing, and says it needed permission — a
  failure that looks like a model declining the task. `--allowed-tools Read Write` fixes it and
  is now in `claudeArgs`. `--permission-mode acceptEdits` also works but auto-accepts edits
  generally; the allowlist states exactly what an unattended run may do.
- **The derived foreground colours fail WCAG AA on ordinary tokens — three of six pairs on the
  house fallback palette.** Measured 2026-09-04 against the real run's tokens:
  `secondary/secondary-foreground` **3.6:1**, `accent/accent-foreground` **3.16:1**,
  `muted/muted-foreground` **4.4:1**. On the Maxematics purple the same three read 6.4 / 3.23 /
  4.57 — so `muted` flips either side of 4.5:1 with hue and saturation, and this is not a fixed
  offset that one constant repairs. The fallback palette is the one that ships whenever token
  extraction fails, which makes this the *default* rather than an edge case. It is a
  `globals.css` derivation bug, not a token-extraction bug; `contrast.ts` flags it every run and
  never adjusts. Fixing it means changing the computed-colour block, which belongs with palette
  work rather than with ANALYSIS.
- **Token extraction returns the fallback on the Maxematics replay's own reference site.**
  `https://edufor.framer.wiki/` yields `no-brand-color-found`, so the replay themes on the grey
  house palette rather than anything derived from E1. Stage (a) behaves correctly — it flags and
  falls back — but the replay is not currently exercising real extraction.

## Decisions worth not re-making

- **This repo is consumed as SOURCE by `aethr-portal`, not as a package.** Its
  `scripts/sync-template.mjs` mirrors `src/lib/{assembly,edit,theme}`, `src/lib/utils.ts`
  and `src/components/{sections,ui,layout}` into its own tree on every build. Two
  consequences that matter here: **the section, ui and layout components must not reintroduce
  `@/` imports** (they would resolve against the portal's `src/`), and a new file those
  components import needs a row in that script's `MIRRORED` list or the portal build fails.
  `assemble.ts` and `generate.ts` are deliberately excluded — they read the filesystem and
  belong to the build.
- **`src/lib/edit/index.ts` is a named export list, and that list IS the interface.** It was
  three `export *` lines until 2026-09-21 — 23 incidental symbols, five of which no caller had
  ever imported. Now 22 explicit named exports. `html-scan.ts` is not exported at all. Adding a
  symbol there is adding to a contract `aethr-portal` builds against **across a repo boundary**
  through `sync-template.mjs`, so it is a decision, not a keystroke.
- **Exactly two files are deliberately NOT re-exported, both because they render.**
  `preview.tsx` pulls in fourteen components behind a `"use client"` boundary; a server route
  importing the partition would drag the whole section tree into a server bundle. `markers.tsx`
  (added Phase 3) is imported by all sixteen section and layout components; routing it through
  the barrel would make **every built client site** import the edit backend — Zod, both readers,
  the write path — to emit attributes no visitor ever sees. Import both directly where they
  render. This is **enforced**, not remembered: `no-restricted-imports` in `eslint.config.mjs`
  carves out exactly these two and errors on every other deep import. A future pass that
  "tidies" the carve-out breaks sixteen components and every client bundle.
- **`scripts/check-*` are exempt from that rule on purpose.** They are this module's own
  conformance harness — an internal test seam, not callers — and `check-edit-markers-parity.ts`
  reads `spec-adapter`, `markers` and `preview` directly. Tightening the rule to cover
  `scripts/` breaks Phase 3's parity guarantee.

- **Playwright is installed once, in this package, and is shared.** `pnpm add -D
  playwright` plus `npx playwright install chromium` ran here, in `aethr-base-template`,
  not in a new workspace root — there is no monorepo root across `Business/apps/`,
  and 008/009 both scope the runtime to this package (`analysis/` and the future `qa/` sit
  as sibling folders under `src/lib/`). **The QA suite must import this same install, never
  run its own `pnpm add playwright`** — a second install would silently duplicate the
  ~180MB Chromium download and drift version-wise from the one token extraction is
  verified against.
- **`waitUntil: "networkidle"` alone is the wrong wait condition for real reference
  sites.** The first version of this script used it and produced a false
  `navigation-timeout` against `aethrdesign.com` — a perfectly reachable site whose
  analytics/chat beacons never let the network go fully idle. Fixed by waiting for `"load"`
  (hard requirement, still time-boxed) then a **best-effort** 5s `networkidle` wait that is
  swallowed on timeout rather than failing the run. Re-verify this specifically if reference
  sites start reporting spurious timeouts again — it is exactly the kind of failure this
  script's own rule (flag, never guess) would otherwise mask as a "the client's site is
  slow" excuse.
- **A colour survives the neutral filter only if it clears a real chroma/lightness test**,
  not merely "not literally #FFFFFF". Near-black, near-white and low-chroma greys are all
  filtered out before hue is ever read — verified this correctly waves through a real
  low-saturation dark UI without misreading its charcoal chrome as a saturated brand hue,
  at the cost of `no-brand-color-found` firing on genuinely monochrome/near-monochrome
  reference sites (`nextjs.org`, and `aethrdesign.com`'s current Framer build, both hit this
  in verification). That is the intended behaviour, not a bug to loosen: a false "brand
  colour" read off UI chrome is worse than an honest REVIEW flag.

- **The Turnstile site key is a build-time env var, not a `SiteSpec` field.** It is public by
  design, and it is infrastructure rather than content: it does not exist at ANALYSIS time,
  because the widget is created during per-client zone setup. Putting it in the spec would
  place a value nobody has yet into the document a human approves, and would change
  `ContactProps`, the contact schema and `SPEC-FORMAT.md` for something no client ever
  authors.
- **A coverage guard has to be a mapped type, not an interface `extends`.** The first
  `SectionPropsByType` was `interface … extends Record<SectionType, unknown>`, which is
  **inert**: an interface inherits the members it does not redeclare, so a deleted row
  resolved to `unknown` and `tsc` stayed green. `{ [K in SectionType]: SectionProps[K] }`
  catches it on the indexed access. Same failure mode as the conformance guard's first
  implementation, in a different disguise — negative-control every guard in this repo before
  trusting it.
- **Schemas constrain shape, never content.** No min-lengths, no content enums, nothing
  that tells the generator what to write (Notes ruling 10, "closed palette, open hand").
  `.strict()` is a shape constraint and is what turns a typo into a named error;
  "non-empty" is deliberately *not* enforced and belongs to the copy rules at ANALYSIS.
- **The conformance guard is written as strict type identity, not mutual assignability.**
  Assignability was the first implementation and was inert: an extra optional prop on one
  side satisfies `extends` in both directions, so a drifted schema passed clean. Any
  rewrite must be re-verified by breaking a schema and watching `tsc` fail — three drift
  modes were checked (schema-ahead, component-ahead, required/optional flip).
- **The discriminated union is spelled out rather than mapped over
  `SECTION_PROP_SCHEMAS`.** `Object.entries` widens the key to `string`, which collapses
  `type` to `unknown` for every downstream consumer of `SiteSpec`.
- **A verification build is throwaway.** `assemble.ts` overwrites `src/app/page.tsx` and
  `src/lib/client-config.ts`, both tracked — assemble, build, then `git checkout --` them.
- The dev server is registered in the Vault-root `.claude/launch.json` as
  `aethr-base-template` on port 3005. Do not add a project-local one.
- **DEPLOY must never rebuild, and the manifest is what enforces it.** The precedent this
  replaces failed exactly here: Maxematics' `deploy-live.sh` rewrote `noindex` → `index`,
  deleted pages and added files *after* the last thing anyone looked at, so staging and
  live were built from one source and were not the same bytes. If the drift guard is ever
  refactored, re-verify it by reproducing that mutation and watching DEPLOY refuse.
- **`run_worker_first` scoping is the whole cost model, so prove it rather than assume
  it.** Swap the Worker's asset fallback for a distinctive status and confirm `/`, an
  asset path and a 404 all still come from assets. Static hits are exempt from the
  100k/day cap; Worker invocations are not.
- **The compatibility date is pinned, not "today".** A date that moves on every deploy
  makes the runtime a variable, so redeploying an unchanged site could behave differently
  from the version the client approved. Bump deliberately.
- **`rail.ts` has three categories, not two, and Phase 2 must respect all three.** Rail
  (§2's eight fields, overwritten verbatim) and *passthrough* — Group-A identity, C5's
  `portfolio.projects[].title/description`, `disclosure.body`, `footer.socialLinks.*` — are
  both outside the linter's scope, by different reasoning. Passthrough is client-typed text
  the voice doc never put on the rail; linting it fires rule 3 on a business honestly called
  "Premier Roofing". `generatedStringPaths()` is the only correct linter input.
- **`prompt.md` is generated and the generation is the guard.** Its content-bearing sections
  are sliced verbatim out of `productized-voice.md` and MAP ruling 10, so no session can
  quietly add a copy rule by editing the prompt — an added rule has to go into the voice doc,
  where the owner sees it. If a slot extractor is ever "simplified" into a hand-written
  string, that guard is gone. Re-verify idempotency by rebuilding twice and diffing.
- **A stale fact in the voice doc reaches the model verbatim.** §4's note that `SiteSpec` has
  no `eyebrow` prop was true when written and false after 2026-09-04; it was being copied
  into every generation run. Corrected at the source, in the voice doc, not patched in the
  template — patching the template would have hidden the drift instead of fixing it.
- **Rail matching must build its identity the same way on both sides.** The first
  implementation compared each drafted prop separately against a concatenated intake identity —
  a stat `{value: "12", label: "Topics"}` scored 0.5 against `"12 Topics"` on either prop alone,
  fell under the 0.8 threshold, and **every stat on the page was deleted as invented**. The
  harness caught it; nothing else would have, because the failure looks like a model that
  omitted a section. `overwriteArray` now takes `{intake, draft}` identity functions.
- **The 0.8 match threshold has a deliberate consequence, and it is not a bug.** A lightly
  paraphrased rail item (re-punctuated, same words) is restored verbatim. A heavily reworded one
  falls below the threshold and is removed and flagged as not-in-intake, while the intake item
  it displaced is flagged as omitted. That is the correct reading: a rewritten testimonial is
  the model *writing* a testimonial, and REVIEW should see both halves rather than get a
  silently-accepted invention. Do not "fix" this by lowering the threshold.
- **The prompt reaches the child on stdin because there is no file flag.** `--system-prompt-file`
  does not exist on 2.1.258 (checked). Inlining a 16 KB prompt into argv is both a quoting
  surface and a length limit, and a heredoc is what produced the 2026-07-17 overnight failures.
  `spawn` with an argv array plus piped stdin has neither problem.
- **The probe is only believable because of its negative control.** Every `--restricted`
  variant answers NO to all three canary strings, which is indistinguishable from a probe that
  simply does not work. `probe-cwd.ts` therefore ships a final variant that drops
  `--restricted` and expects YES/YES/YES. If that control ever stops returning YES, the probe
  is broken and its NOs mean nothing. Asking the model to *inventory* its context does not
  work either — the first run had every variant answer "NONE" while reporting between 0 and
  28,000 characters of supplied content.
- **An invocation failure is not a structural failure.** 008 §4's three attempts are for the
  model's *output*. Spending them on a bad flag hid the `--json-schema` rejection behind three
  identical "attempts" and produced a `failed` result that looked like a model problem.
  `InvocationError` returns immediately with the CLI's own message.
- **The prompt and the runner must agree on file names, and only a real run proves it.** The
  prompt said `intake.json`; the runner writes `input.json`, which is 008 §7's provenance name.
  The model refused to generate and explained exactly why — the correct behaviour, and the
  whole reason the real run was worth its tokens. No fixture or type would have caught it.
- **`src/lib/analysis/assert.ts` is the 008 §7 structural assertion suite.** Reads
  `input.json`/`tokens.json`/`structure.json`/`spec.json`/`linter-report.json`/`run.json` and
  re-derives every check from those six files rather than trusting another stage's report —
  rule 1 and rule 5 are re-run against the same `allowedNumbers`/`digitsIn`/`PLACEHOLDERS`
  primitives `copy-floor.ts` uses (now exported for this reason), not reimplemented in
  parallel. Green on the real Maxematics run, the mock replay of the same draft, and the
  semantic negative control — a clean structural suite passing the semantic control **is**
  correct, since every planted defect there is repaired, blanked or pruned before `spec.json`
  exists. Red, by design, on the structural control: eight of thirteen checks report "no
  spec.json" by name, and a dedicated `parked-run-shape` check separately confirms the park
  itself is legitimate (`needs-attention`, three failed attempts, no `spec.json`) rather than
  trying to validate a file that was never written.
- **`assert.ts --expect <manifest>` is a second, narrower instrument, and must not be folded
  into the general suite.** It asserts the floor *caught* a specific planted defect — the
  string is gone from `spec.json` **and** `linter-report.json` names the entry that removed
  it — which the general suite cannot tell apart from "the model just didn't happen to write
  that." The fixture manifest is `tasteled/assets/prototype/expect-negative-semantic.json`,
  ten defects, all confirmed caught on the semantic control (exit 0); run against the clean
  Maxematics run it correctly reports most as NOT caught (exit 1) — proof the check
  discriminates rather than passing vacuously. **Deviation from the phase prompt, recorded
  for the owner to override:** the prompt's one-line "Verification" checklist says `--expect`
  should go red on the semantic control; the same phase's own detailed ruling says `--expect`
  "asserts the floor caught the defect" — which, on the semantic control where the floor did
  its job, is a pass. Implemented per the ruling (exit 0 = every defect confirmed caught);
  the checklist line's "red" is read as report styling (each defect printed as a flagged
  line), not exit-code semantics. Revisit if that reading is wrong.

---
