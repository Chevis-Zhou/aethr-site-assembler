import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { z } from "zod/v4";
import { assembleFromSpec } from "../assembly/assemble";
import { siteSpecSchema, type SiteSpec } from "../assembly/site-spec";
import { runAxe, runLayoutChecksForPage, runLighthouse, serveStatic, settlePage, writeReport } from "tasteled-qa";
import { runContentChecksForPage, type LinkCache } from "./content-checks";
import { checkAssetManifest } from "./asset-check";
import { newCheckContext } from "./browser-context";
import type { CheckResult, QASuiteResult } from "./types";
import { fromShared, toShared, verdictOf, blockers } from "./types";

/**
 * The full suite orchestrator, `qa-specification.md` §8's "full suite" row: content checks
 * + layout assertions + accessibility floor + asset check, run against a local production
 * build. Layout, accessibility, settling, serving and the report are `tasteled-qa`'s; this
 * file owns what is pipeline-specific — assembling from a spec, the spec's page list, the
 * asset check, and the PARKED/STAGED/PASS verdict. Each check is exported standalone
 * (here or from `tasteled-qa`) so a failure names itself without re-running the whole thing.
 */

export type CheckName = "content" | "layout" | "a11y" | "asset" | "all";

export interface RunOptions {
  specPath: string;
  projectRoot: string;
  outDir: string;
  check: CheckName;
  skipAssemble?: boolean;
  skipBuild?: boolean;
  lighthousePages?: string[]; // default: just "/" — see the deviation note below
}

/** Framework paths under `src/app/` that no spec ever generates and must survive a reset. */
const PRESERVED_APP_ENTRIES = new Set(["layout.tsx", "globals.css", "favicon.ico", "showcase", "api"]);

/**
 * `assembleFromSpec` only writes the page paths the CURRENT spec names — it never removes
 * a page directory a PREVIOUS spec created (e.g. a leftover `about/` from a wider site
 * assembled earlier). Left alone, that stale route silently rides along into the next
 * spec's build. The suite needs to know exactly what's in the build, so it resets first.
 */
export function resetGeneratedPages(projectRoot: string): void {
  const appDir = path.join(projectRoot, "src/app");
  for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
    if (PRESERVED_APP_ENTRIES.has(entry.name)) continue;
    fs.rmSync(path.join(appDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * Tracked files `assembleFromSpec` overwrites. Same pair `analysis/run.ts` restores after a
 * verification build, and for the same reason (STATE.md: "a verification build is
 * throwaway") — a QA run is an oracle, not an edit. Leaving them rewritten meant every
 * replay ended with the client's site sitting in the working tree as an uncommitted diff,
 * which the next session reads as real work.
 */
const ASSEMBLER_TRACKED_OUTPUTS = ["src/app/page.tsx", "src/lib/client-config.ts"];

export function restoreAssemblerOutputs(projectRoot: string): void {
  try {
    execFileSync("git", ["checkout", "--", ...ASSEMBLER_TRACKED_OUTPUTS], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // A repo without these tracked (a fresh clone mid-rebase, someone running the suite
    // outside git) must not turn a green QA run red. The restore is hygiene, not a check.
  }
}

function loadSpec(specPath: string): SiteSpec {
  const raw = JSON.parse(fs.readFileSync(specPath, "utf-8"));
  const result = z.safeParse(siteSpecSchema, raw);
  if (!result.success) throw new Error(`Spec validation failed:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export async function runFullSuite(opts: RunOptions): Promise<QASuiteResult> {
  const spec = loadSpec(opts.specPath);
  const results: CheckResult[] = [];
  const allScreenshots: string[] = [];
  let assembled = false;

  if (!opts.skipAssemble) {
    resetGeneratedPages(opts.projectRoot);
    assembleFromSpec(opts.specPath, opts.projectRoot);
    assembled = true;
  }
  if (!opts.skipBuild) {
    execFileSync("pnpm", ["build"], { cwd: opts.projectRoot, stdio: "inherit" });
  }

  const server = await serveStatic(path.join(opts.projectRoot, "out"));
  // One Chromium instance for the whole suite, launched with its own CDP port so Lighthouse
  // (which drives it over raw CDP, not through Playwright) can share it.
  const cdpPort = 9222 + Math.floor(Math.random() * 1000);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
  const context = await newCheckContext(browser);
  const cache: LinkCache = new Map();
  const lighthouse: Record<string, unknown> = {};

  try {
    // -- content checks (check 1-8), one page context per spec page --
    if (opts.check === "content" || opts.check === "all") {
      const contentFindings: QASuiteResult["results"][number]["findings"] = [];
      for (const [pageIndex, pageSpec] of spec.pages.entries()) {
        const url = `${server.url}${pageSpec.slug === "/" ? "/" : pageSpec.slug}`;
        const page = await context.newPage();
        try {
          const rawHtml = await (await fetch(url)).text();
          await page.goto(url, { waitUntil: "load" });
          // Same reason as the layout stage: checks 1, 2 and 5 all read rendered text, and
          // a count-up caught mid-flight makes check 1 report a hydration diff and check 2
          // compare against a number the page was only passing through.
          await settlePage(page);
          const findings = await runContentChecksForPage({
            page,
            url,
            origin: server.url,
            rawHtml,
            spec,
            pageSpec,
            pageIndex,
            cache,
          });
          contentFindings.push(...findings);
        } finally {
          await page.close();
        }
      }
      results.push({ check: "content-checks", ok: contentFindings.length === 0, findings: contentFindings });
    }

    // -- layout assertions + screenshots, 4 widths per page --
    if (opts.check === "layout" || opts.check === "all") {
      const layoutFindings: QASuiteResult["results"][number]["findings"] = [];
      const screenshotDir = path.join(opts.outDir, "screenshots");
      for (const pageSpec of spec.pages) {
        const url = `${server.url}${pageSpec.slug === "/" ? "/" : pageSpec.slug}`;
        const page = await context.newPage();
        try {
          const { findings, screenshots } = await runLayoutChecksForPage({
            page,
            url,
            pathname: pageSpec.slug,
            screenshotDir,
          });
          layoutFindings.push(...fromShared(findings));
          allScreenshots.push(...screenshots);
        } finally {
          await page.close();
        }
      }
      results.push({ check: "layout-assertions", ok: layoutFindings.length === 0, findings: layoutFindings });
    }

    // -- accessibility floor: axe-core on every page, Lighthouse on the homepage only --
    //
    // Deviation, documented per plan-pipeline discipline: the spec doesn't scope Lighthouse
    // to a subset of pages, but §4's own reasoning for the =100 threshold — "the component
    // palette is closed and identical across every client, a defect in it is a template
    // regression to be found once" — applies equally to which pages need a Lighthouse pass.
    if (opts.check === "a11y" || opts.check === "all") {
      const a11yFindings: QASuiteResult["results"][number]["findings"] = [];
      for (const pageSpec of spec.pages) {
        const url = `${server.url}${pageSpec.slug === "/" ? "/" : pageSpec.slug}`;
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "load" });
          await settlePage(page);
          a11yFindings.push(...fromShared(await runAxe(page, url)));
        } finally {
          await page.close();
        }
      }
      const lighthousePages = opts.lighthousePages ?? ["/"];
      for (const slug of lighthousePages) {
        const url = `${server.url}${slug === "/" ? "/" : slug}`;
        // Performance is recorded as evidence and gates nothing (owner ruling, §6). It used to
        // be an always-on advisory, which meant no site could ever reach PASS.
        const { findings, scores } = await runLighthouse(url, cdpPort);
        lighthouse[slug] = scores;
        a11yFindings.push(...fromShared(findings));
      }
      results.push({
        check: "accessibility-floor",
        ok: a11yFindings.filter((f) => f.severity === "blocker").length === 0,
        findings: a11yFindings,
        evidence: Object.keys(lighthouse).length ? { lighthouse } : undefined,
      });
    }
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }

  // -- asset check: manifest coverage over the actual build output --
  if (opts.check === "asset" || opts.check === "all") {
    const assetFindings = await checkAssetManifest(path.join(opts.projectRoot, "out"), opts.projectRoot);
    results.push({ check: "asset-manifest", ok: assetFindings.length === 0, findings: assetFindings });
  }

  const result: QASuiteResult = {
    slug: spec.client.name,
    target: `${opts.projectRoot}/out (local production build)`,
    ranAt: new Date().toISOString(),
    pages: spec.pages.map((p) => p.slug),
    results,
  };

  writeReport(toShared(result), allScreenshots, opts.outDir);

  // After the report, not before: `out/` is already built and served, so putting the
  // sources back cannot change a single finding — it only stops the run leaving a diff.
  if (assembled) {
    resetGeneratedPages(opts.projectRoot);
    restoreAssemblerOutputs(opts.projectRoot);
  }

  return result;
}

// CLI: npx tsx src/lib/qa/run.ts --spec <path> [--project-root <path>] [--out-dir <path>]
//      [--check content|layout|a11y|asset|all] [--skip-build] [--skip-assemble]
if (process.argv[1]?.replace(/\\/g, "/").includes("qa/run")) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const specPath = flag("--spec");
  if (!specPath) {
    console.error("Usage: npx tsx src/lib/qa/run.ts --spec <path> [options]");
    process.exit(1);
  }

  const opts: RunOptions = {
    specPath: path.resolve(specPath),
    projectRoot: path.resolve(flag("--project-root") ?? process.cwd()),
    outDir: path.resolve(flag("--out-dir") ?? path.join(process.cwd(), "qa-runs", String(Date.now()))),
    check: (flag("--check") as CheckName) ?? "all",
    skipBuild: args.includes("--skip-build"),
    skipAssemble: args.includes("--skip-assemble"),
  };

  runFullSuite(opts)
    .then((result) => {
      const verdict = verdictOf(result);
      const blockerCount = blockers(result).length;
      console.log(`\n${verdict}${blockerCount ? ` — ${blockerCount} blocker(s)` : ""}`);
      console.log(`Report: ${path.join(opts.outDir, "report.html")}`);
      process.exit(verdict === "PARKED" ? 1 : 0);
    })
    .catch((err: unknown) => {
      console.error("QA run failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
