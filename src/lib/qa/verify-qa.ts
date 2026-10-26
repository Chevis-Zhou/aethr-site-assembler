import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runFullSuite } from "./run";
import { htmlToText } from "./content-checks";
import { verdictOf, blockers, advisories } from "./types";

/**
 * Verifying the suite itself, `qa-specification.md` §10. An unverified QA suite is worse
 * than no suite — it produces a green verdict with no reason to trust it.
 *
 * - Negative control: `fixtures/negative-control.json`, crafted to trip a blocker in every
 *   content-sanity check the harness can drive from spec data alone (§5.1's checks 2/3/4/5/6/7
 *   and §5.1 check 8's h1 count). Must PARK.
 * - Positive control: `fixtures/maxematics-v1.json` — the real ANALYSIS output for the
 *   Maxematics replay (`_replay-maxematics/analysis/2026-09-06T22-44-02.255Z/spec-approved.json`,
 *   the Phase 5 acceptance run), with the two page-level REVIEW-flagged blanks
 *   (`client.description`, `pages[0].description`) filled the way a human would at REVIEW
 *   before BUILD ever runs. Section props the copy floor blanked are left blank on purpose —
 *   007 ruled REVIEW read-only for copy, and the flags sheet marks only the page-level
 *   fields as needing a human. Must PASS clean.
 *
 *   **Replaced the 2026-09-05 fixture deliberately.** That one passed only because none of
 *   its copy contained an apostrophe, which is the single character that broke check 1 (see
 *   `htmlToText`). A positive control that cannot fail on the commonest punctuation mark in
 *   English prose is not exercising the check it is supposed to protect. This spec carries
 *   "USF's" and "Founder & tutor", so it can.
 *
 * - Entity guard: `htmlToText` is also checked directly against a table of escapes, because
 *   a fixture only covers the characters its client happened to write. The table covers the
 *   ones React's SSR emits, in both hex and decimal form.
 *
 * Deliberately not forced by either fixture: the accessibility floor (Lighthouse/axe) and
 * the layout assertions. Both operate on the closed, shared component palette rather than
 * on spec content — §4's own reasoning ("an accessibility defect in it is a template
 * regression to be found once") is exactly why spec data can't script one. This harness
 * verifies those two stages run clean on both controls, not that they can be tripped by data.
 */

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.join(PROJECT_ROOT, "src/lib/qa/fixtures");

async function main() {
  let failed = false;

  // Build once — both controls assemble into the same project, so each run needs its own
  // assemble+build pass immediately before its suite run.
  console.log("=== Negative control ===");
  const negOutDir = path.join(PROJECT_ROOT, "qa-verification", "negative-control");

  // The negative control's founder-image fixture is staged into `public/` only for this
  // run and removed after — `public/` isn't reset between spec assembles the way
  // `src/app/` is (`resetGeneratedPages`), so a fixture left there would silently fail
  // every LATER build's asset-manifest check too, including the positive control's.
  const fixtureImageDest = path.join(PROJECT_ROOT, "public/qa-fixtures/negative-control.jpg");
  fs.mkdirSync(path.dirname(fixtureImageDest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "negative-control.jpg"), fixtureImageDest);

  let negResult;
  try {
    negResult = await runFullSuite({
      specPath: path.join(FIXTURES, "negative-control.json"),
      projectRoot: PROJECT_ROOT,
      outDir: negOutDir,
      check: "all",
    });
  } finally {
    fs.rmSync(path.dirname(fixtureImageDest), { recursive: true, force: true });
  }
  const negVerdict = verdictOf(negResult);
  const negBlockers = blockers(negResult);
  console.log(`Verdict: ${negVerdict} (${negBlockers.length} blockers, ${advisories(negResult).length} advisories)`);
  for (const b of negBlockers) console.log(`  [${b.check}] ${b.message}`);

  // Generic checks carry `tasteled-qa`'s ids; the rest are this pipeline's own.
  const expectedChecks = [
    "content-2-number-vs-dom-count",
    "placeholder-text",
    "links-and-anchors",
    "contact-identity",
    "content-6-empty-section",
    "blank-alt-text",
    "title-meta-h1",
    "landmark-count",
    "asset-manifest-coverage",
  ];
  const firedChecks = new Set(negBlockers.map((b) => b.check));
  const missing = expectedChecks.filter((c) => !firedChecks.has(c));

  if (negVerdict !== "PARKED") {
    console.error(`FAIL: negative control expected PARKED, got ${negVerdict}.`);
    failed = true;
  }
  if (missing.length > 0) {
    console.error(`FAIL: negative control did not trip: ${missing.join(", ")}`);
    failed = true;
  }
  if (!failed) console.log("PASS: negative control tripped every expected blocker.\n");

  console.log("=== Entity guard (htmlToText) ===");
  // Check 1 compares raw SSR HTML against the hydrated DOM. The DOM side always has
  // decoded characters, so any escape `htmlToText` fails to decode reads as a hydration
  // mismatch and PARKS a site that is fine. `&#x27;` did exactly that until 2026-09-06.
  const entityCases: [string, string][] = [
    ["&#x27;", "'"],
    ["&#39;", "'"],
    ["&#039;", "'"],
    ["&apos;", "'"],
    ["&quot;", '"'],
    ["&#x22;", '"'],
    ["&amp;", "&"],
    ["&#x26;", "&"],
    ["&lt;", "<"],
    ["&#x3C;", "<"],
    ["&gt;", ">"],
    ["&#62;", ">"],
    ["&#x2F;", "/"],
    ["&nbsp;", " "],
  ];
  const entityFailures = entityCases.filter(([raw, want]) => htmlToText(`<p>a${raw}b</p>`) !== `a${want}b`);
  for (const [raw, want] of entityFailures) {
    console.error(`  FAIL: htmlToText("${raw}") did not decode to "${want}" — got "${htmlToText(`<p>a${raw}b</p>`)}"`);
  }
  if (entityFailures.length) {
    console.error(`FAIL: ${entityFailures.length} entity/entities left undecoded — check 1 will park clean sites.`);
    failed = true;
  } else {
    console.log(`PASS: all ${entityCases.length} escapes decode.\n`);
  }

  console.log("=== Positive control (Maxematics v1) ===");
  const posOutDir = path.join(PROJECT_ROOT, "qa-verification", "maxematics-v1");
  const posResult = await runFullSuite({
    specPath: path.join(FIXTURES, "maxematics-v1.json"),
    projectRoot: PROJECT_ROOT,
    outDir: posOutDir,
    check: "all",
  });
  const posVerdict = verdictOf(posResult);
  const posBlockers = blockers(posResult);
  console.log(`Verdict: ${posVerdict} (${posBlockers.length} blockers, ${advisories(posResult).length} advisories)`);
  for (const b of posBlockers) console.log(`  [${b.check}] ${b.message}`);
  for (const a of advisories(posResult)) console.log(`  (advisory) [${a.check}] ${a.message}`);

  if (posVerdict === "PARKED") {
    console.error(`FAIL: Maxematics v1 positive control must pass clean, got PARKED.`);
    failed = true;
  } else {
    console.log(`PASS: Maxematics v1 positive control did not park (${posVerdict}).\n`);
  }

  // Restore the repo's own page.tsx / client-config.ts — assemble.ts overwrites tracked
  // files, and a verification run is throwaway per STATE.md's standing convention.
  try {
    execFileSync("git", ["checkout", "--", "src/app/page.tsx", "src/lib/client-config.ts"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
  } catch {
    console.warn("Could not git-checkout the verification-build scratch files — check `git status`.");
  }

  console.log(failed ? "\nVERIFY: FAIL" : "\nVERIFY: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("verify-qa failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
