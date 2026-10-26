import type { Page } from "playwright";
import {
  checkContactIdentity,
  checkHeadAndStructure,
  checkImages,
  checkLinks,
  checkPlaceholders,
  checkServerVsHydrated,
} from "tasteled-qa";
import type { SiteSpec } from "../assembly/site-spec";
import { fromShared, type CheckFinding } from "./types";

/**
 * The rendered-HTML checks, `qa-specification.md` §5.1. All run against a static export's
 * actual served HTML — the surface that survives a valid `spec.json` and a clean
 * `next build` (008/009's seam) — never against `spec.json` itself, which ANALYSIS's copy
 * floor already linted.
 *
 * Checks 1, 3, 4, 5, 7 and 8 are `tasteled-qa`'s (the public extraction of this suite,
 * ticket 032), with the severity policy in `types.ts` → `fromShared`. What stays here is what
 * only a spec-driven site can check, plus the two places this pipeline is deliberately
 * stricter than a gate built for strangers' sites. One implementation per check: a fix to a
 * generic check lands in `tasteled-qa` and reaches this suite on the next version bump.
 */

export { htmlToText } from "tasteled-qa";

/** Shared across pages so a footer link is fetched once per run, not once per page. */
export type LinkCache = Map<string, number | string>;

// -- check 2: number-vs-DOM count ---------------------------------------------

/** Noun → the spec array whose length that noun plausibly claims. Deliberately narrow —
 * see the deviation note in `SPEC.md`: this is scoped to page title/description, the one
 * surface the resolution names, not a general prose-mining pass over every string. */
const COUNT_NOUNS: { pattern: RegExp; countOf: (section: SiteSpec["pages"][number]["sections"][number]) => number | null }[] = [
  { pattern: /\btopics?\b/i, countOf: (s) => (s.type === "services" ? s.props.services.length : null) },
  { pattern: /\bsubjects?\b/i, countOf: (s) => (s.type === "services" ? s.props.services.length : null) },
  { pattern: /\bservices?\b/i, countOf: (s) => (s.type === "services" ? s.props.services.length : null) },
  { pattern: /\bprojects?\b/i, countOf: (s) => (s.type === "portfolio" ? s.props.projects.length : null) },
  { pattern: /\btestimonials?\b|\breviews?\b/i, countOf: (s) => (s.type === "testimonials" ? s.props.testimonials.length : null) },
  { pattern: /\bcredentials?\b/i, countOf: (s) => (s.type === "credentials" ? s.props.credentials.length : null) },
  { pattern: /\bfeatures?\b/i, countOf: (s) => (s.type === "feature-list" ? s.props.features.length : null) },
  { pattern: /\bquestions?\b|\bfaqs?\b/i, countOf: (s) => (s.type === "faq" ? s.props.items.length : null) },
  { pattern: /\bplans?\b|\btiers?\b|\bpackages?\b/i, countOf: (s) => (s.type === "pricing" ? s.props.tiers.length : null) },
];

function checkCountClaim(
  text: string,
  textLabel: string,
  sections: SiteSpec["pages"][number]["sections"],
  url: string,
  /**
   * The `spec.json` path the offending text came from.
   *
   * Ticket 012 §4.2: this check stays blocking, but against a client self-edit the failure
   * has to be *locatable* — "a client who adds a fourth service now fails on a sentence
   * elsewhere that still says three". Carrying the path is what lets the editor name that
   * sentence and offer the fix inline instead of reporting a failure the client cannot find.
   */
  fieldPath?: string,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const numberMatches = [...text.matchAll(/\b(\d{1,3})\s+([a-zA-Z][a-zA-Z-]*)/g)];

  for (const match of numberMatches) {
    const claimed = Number(match[1]);
    const noun = match[2];
    const rule = COUNT_NOUNS.find((r) => r.pattern.test(noun));
    if (!rule) continue;

    const actualCounts = sections.map(rule.countOf).filter((n): n is number => n !== null);
    if (actualCounts.length === 0) continue; // no matching list on this page — nothing to check

    if (!actualCounts.includes(claimed)) {
      findings.push({
        severity: "blocker",
        check: "content-2-number-vs-dom-count",
        message: `"${match[0]}" in ${textLabel} does not match the rendered count.`,
        url,
        selector: fieldPath,
        expected: actualCounts.join(" or "),
        actual: String(claimed),
      });
    }
  }
  return findings;
}

export function checkNumberVsDomCount(
  page: SiteSpec["pages"][number],
  renderedTitle: string,
  renderedDescription: string | null,
  url: string,
  /** Index of this page in `spec.pages`, so a finding can name a writable field path. */
  pageIndex?: number,
): CheckFinding[] {
  const base = pageIndex === undefined ? undefined : `pages[${pageIndex}]`;
  return [
    ...checkCountClaim(renderedTitle, "the page title", page.sections, url, base && `${base}.title`),
    ...(renderedDescription
      ? checkCountClaim(
          renderedDescription,
          "the page description",
          page.sections,
          url,
          base && `${base}.description`,
        )
      : []),
  ];
}

// -- check 6: no empty rendered section ------------------------------------------

export async function checkEmptySections(
  page: Page,
  spec: SiteSpec["pages"][number],
  url: string,
): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];

  for (const section of spec.sections) {
    const props = section.props as { heading?: string; headline?: string; eyebrow?: string };
    const heading = props.heading ?? props.headline;
    if (!heading) continue;

    // Each section renders inside a `<div id="{type}">` wrapper (generate.ts) — the same
    // id a single-page site's own nav/CTA anchors target, and a far more reliable handle
    // than document-order indexing once two sections can share a type.
    // section.type is a closed-enum identifier (hero, about, services, ...), never
    // user-authored text, so it's safe to interpolate directly into the selector.
    const rendered = await page
      .locator(`#${section.type}`)
      .first()
      .innerText()
      .then((t) => t.replace(/\s+/g, " ").trim())
      .catch(() => undefined);
    if (rendered === undefined) continue; // section didn't render at all — check 4/structural catches this

    const expectedMinimal = [props.eyebrow, heading].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    // Heuristic: a section whose entire visible text is just its eyebrow + heading (give or
    // take a few characters) has nothing rendering below the title.
    if (rendered === expectedMinimal || rendered.length <= expectedMinimal.length + 3) {
      findings.push({
        severity: "blocker",
        check: "content-6-empty-section",
        message: `Section "${section.type}" renders a heading with no body.`,
        url,
        selector: `#${section.type}`,
      });
    }
  }

  return findings;
}

// -- stricter than tasteled-qa: blank alt text ---------------------------------------

/**
 * `tasteled-qa` passes `alt=""`, which is correct for a decorative image on a hand-built
 * site. Here an image's alt comes from spec copy (`about.tsx` renders `alt={founderName ??
 * ""}`), so a blank one is a copy-floor miss, not a decoration decision.
 */
export async function checkBlankAltText(page: Page, url: string): Promise<CheckFinding[]> {
  const blanks = await page.$$eval("img[alt]", (imgs) =>
    imgs.filter((img) => (img.getAttribute("alt") ?? "").trim() === "").map((img) => img.getAttribute("src") ?? ""),
  );
  return blanks.map((src) => ({
    severity: "blocker",
    check: "blank-alt-text",
    message: `<img src="${src}"> has blank alt text — the spec field it renders from is empty.`,
    url,
    selector: `img[src="${src}"]`,
  }));
}

// -- stricter than tasteled-qa: landmark count ----------------------------------------

/**
 * `layout.tsx` renders a header and a footer on every route from `clientConfig`, and
 * `header`/`footer` are also section types a spec can place inline — so a spec that includes
 * one ships the page with two, stacked and identical. Every archetype skeleton did exactly
 * this until 2026-09-06 and nothing caught it.
 *
 * `tasteled-qa`'s `duplicate-landmark` counts page-level landmarks only, to spare a
 * stranger's `<article><footer>`. The inline section renders inside `<main>`, so that rule
 * misses precisely this defect; with a closed component palette there is no legitimate
 * nested header or footer to spare. This check replaces it here.
 */
export async function checkLandmarkCount(page: Page, url: string): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  for (const landmark of ["header", "footer"] as const) {
    const count = await page.locator(landmark).count();
    if (count > 1) {
      findings.push({
        severity: "blocker",
        check: "landmark-count",
        message: `Page has ${count} <${landmark}> elements, expected at most 1 — the site layout already renders one, so a "${landmark}" section in the spec duplicates it.`,
        url,
      });
    }
  }
  return findings;
}

// -- orchestrator: run every content check against one page ----------------------------

export async function runContentChecksForPage(opts: {
  page: Page;
  url: string;
  origin: string;
  rawHtml: string;
  spec: SiteSpec;
  pageSpec: SiteSpec["pages"][number];
  /** Position of `pageSpec` in `spec.pages` — see `checkNumberVsDomCount`. */
  pageIndex?: number;
  cache?: LinkCache;
}): Promise<CheckFinding[]> {
  const cache = opts.cache ?? new Map();
  const title = await opts.page.title();
  const description = await opts.page
    .locator('meta[name="description"]')
    .first()
    .getAttribute("content")
    .catch(() => null);

  const shared = [
    ...(await checkServerVsHydrated(opts.page, opts.url, opts.rawHtml)),
    ...checkPlaceholders(opts.rawHtml, opts.url),
    // The shared scan reads <body> only; the title is spec copy too.
    ...checkPlaceholders(`<body>${title}</body>`, opts.url),
    ...(await checkLinks(opts.page, opts.url, opts.origin, cache, { external: true })),
    ...checkContactIdentity(opts.rawHtml, opts.url, {
      emails: [opts.spec.client.email],
      phones: opts.spec.client.phone ? [opts.spec.client.phone] : undefined,
    }),
    ...(await checkImages(opts.page, opts.url, cache)),
    ...(await checkHeadAndStructure(opts.page, opts.url)).filter((f) => f.check !== "duplicate-landmark"),
  ];

  return [
    ...fromShared(shared),
    ...checkNumberVsDomCount(opts.pageSpec, title, description, opts.url, opts.pageIndex),
    ...(await checkEmptySections(opts.page, opts.pageSpec, opts.url)),
    ...(await checkBlankAltText(opts.page, opts.url)),
    ...(await checkLandmarkCount(opts.page, opts.url)),
  ];
}
