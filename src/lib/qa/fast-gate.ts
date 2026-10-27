import * as path from "node:path";
import { chromium } from "playwright";
import type { SiteSpec } from "../assembly/site-spec";
import { runContentChecksForPage } from "./content-checks";
import { serveStatic } from "./static-server";
import { settlePage } from "./settle";
import { checkAssetManifest } from "./asset-check";
import type { CheckFinding, QASuiteResult } from "./types";
import { blockers } from "./types";

/**
 * The fast gate — `qa-specification.md` §8's first row: §5.1's eight checks (the link
 * check is one of them) against an already-built `out/`. No opt-out, on every deploy
 * including a client self-edit publish.
 *
 * Why this is not `runFullSuite({ check: "content" })`: that orchestrator assembles and
 * builds first, because it is the pipeline's oracle over a spec. The gate runs *after* the
 * build, on the artifact about to be uploaded — ticket 012 §4 puts it pre-upload precisely
 * so a client edit that breaks the site never reaches a hostname. It also drops Lighthouse
 * and the four-width layout pass, which are the full suite's, and keeps the asset check
 * because a client's own upload is the one input that can arrive unoptimised.
 *
 * The verdict is intentionally binary here. `verdictOf`'s three-way PARKED/STAGED/PASS is
 * the pipeline's instrument; §4.3 rules that a self-edit failure blocks in the editor
 * instead of parking the client, because the person who caused it is sitting in the editor.
 */

export interface FastGateResult {
  passed: boolean;
  ranAt: string;
  findings: CheckFinding[];
  /** Non-blocking findings, surfaced but never a reason to refuse a publish. */
  advisories: CheckFinding[];
}

export async function runFastGate(opts: {
  spec: SiteSpec;
  projectRoot: string;
  outDir?: string;
  cmsPages?: { slug: string; title: string; description?: string }[];
  browserChannel?: "chrome";
}): Promise<FastGateResult> {
  const outDir = opts.outDir ?? path.join(opts.projectRoot, "out");
  const server = await serveStatic(outDir);
  const browser = await chromium.launch(opts.browserChannel ? {channel:opts.browserChannel} : {});
  const context = await browser.newContext();
  const findings: CheckFinding[] = [];

  try {
    const pages = [...opts.spec.pages, ...(opts.cmsPages ?? []).map(p => ({...p, sections:[]}))];
    for (const [pageIndex, pageSpec] of pages.entries()) {
      const url = `${server.url}${pageSpec.slug === "/" ? "/" : pageSpec.slug}`;
      const page = await context.newPage();
      try {
        const response = await fetch(url);
        if (!response.ok) findings.push({severity:"blocker",check:"route-response",message:`Generated route returned HTTP ${response.status}.`,url});
        const rawHtml = await response.text();
        await page.goto(url, { waitUntil: "load" });
        // Checks 1, 2 and 5 all read rendered text; a count-up caught mid-flight makes
        // check 1 report a hydration diff that is really an animation.
        await settlePage(page);
        findings.push(
          ...(await runContentChecksForPage({
            page,
            url,
            origin: server.url,
            rawHtml,
            spec: opts.spec,
            pageSpec,
            pageIndex: pageIndex < opts.spec.pages.length ? pageIndex : undefined,
          })),
        );
      } finally {
        await page.close();
      }
    }

    findings.push(...(await checkAssetManifest(outDir, opts.projectRoot)));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }

  const result: QASuiteResult = {
    slug: opts.spec.client.name,
    target: outDir,
    ranAt: new Date().toISOString(),
    results: [{ check: "fast-gate", ok: findings.length === 0, findings }],
  };

  return {
    passed: blockers(result).length === 0,
    ranAt: result.ranAt,
    findings: blockers(result),
    advisories: findings.filter((f) => f.severity === "advisory"),
  };
}
