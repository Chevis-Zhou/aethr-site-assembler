import type { CheckFinding as SharedFinding, QAResult } from "tasteled-qa";

/** Two failure classes, per `qa-specification.md` §3. Nothing in between. */
export type Severity = "blocker" | "advisory";

export interface CheckFinding {
  severity: Severity;
  check: string;
  message: string;
  url?: string;
  selector?: string;
  expected?: string;
  actual?: string;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  findings: CheckFinding[];
  /** Advisory evidence — e.g. screenshot paths, Lighthouse scores. Never gates anything. */
  evidence?: Record<string, unknown>;
}

export interface QASuiteResult {
  slug: string;
  target: string;
  ranAt: string;
  /** Page paths the suite ran against — `spec.pages`' slugs. */
  pages: string[];
  results: CheckResult[];
}

export function blockers(result: QASuiteResult): CheckFinding[] {
  return result.results.flatMap((r) => r.findings.filter((f) => f.severity === "blocker"));
}

export function advisories(result: QASuiteResult): CheckFinding[] {
  return result.results.flatMap((r) => r.findings.filter((f) => f.severity === "advisory"));
}

export type Verdict = "PARKED" | "STAGED" | "PASS";

export function verdictOf(result: QASuiteResult): Verdict {
  const blockerCount = blockers(result).length;
  if (blockerCount > 0) return "PARKED";
  if (advisories(result).length > 0) return "STAGED";
  return "PASS";
}

// -- the seam with `tasteled-qa` ---------------------------------------------------------

/**
 * The generic checks come from `tasteled-qa`, the public extraction of this suite (ticket
 * 032). It is tuned for strangers' sites, so a few findings it only *warns* on are blockers
 * here — a site assembled from a closed component palette and an approved spec has no
 * legitimate reason to ship them:
 *
 * - `server-vs-hydrated-text` — check 1. A third-party widget can inject text on a stranger's
 *   site; nothing on ours does, so a diff is a real hydration or count-up defect.
 * - `placeholder-text` — `undefined`/`null` are real words on a developer-docs site, never in
 *   client copy.
 * - `title-meta-h1` — over-length title/description is a copy-floor miss, not taste.
 *
 * Every other `warn` (external links, axe moderate, Lighthouse best-practices) stays advisory.
 */
const ESCALATED_CHECKS = new Set(["server-vs-hydrated-text", "placeholder-text", "title-meta-h1"]);

export function fromShared(findings: SharedFinding[]): CheckFinding[] {
  return findings.map((f) => ({
    ...f,
    severity: f.severity === "fail" || ESCALATED_CHECKS.has(f.check) ? "blocker" : "advisory",
  }));
}

/** The pipeline's result in `tasteled-qa`'s shape, so its report renderer can draw it.
 *  PARKED/STAGED/PASS read as FAIL/WARN/PASS there — same three states, public names. */
export function toShared(result: QASuiteResult): QAResult {
  return {
    target: `${result.slug} — ${result.target}`,
    pages: result.pages,
    ranAt: result.ranAt,
    results: result.results.map((r) => ({
      ...r,
      findings: r.findings.map((f) => ({ ...f, severity: f.severity === "blocker" ? "fail" : "warn" })),
    })),
  };
}
