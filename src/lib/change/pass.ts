import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { isFreePath } from "@/lib/edit";

/**
 * A paid change-ticket pass — ticket 026, as data.
 *
 * 026 ruled the path: **REVIEW → BUILD → QA → STAGING → APPROVE → DEPLOY**, entered from
 * the live spec, never from intake. INTAKE is skipped and ANALYSIS is skipped *as a stage*
 * because `analysis/run.ts` regenerates from intake and would wipe post-launch self-edits.
 * This file is the order, the two human gates, and the provenance folder; `run.ts` beside
 * it is the CLI that drives the existing STAGING / DEPLOY / QA code through it.
 *
 * Everything here is pure or touches only the pass folder, so the ordering rules can be
 * checked without a build — `scripts/check-change-pass.ts`.
 */

export const PASS_STAGES = ["REVIEW", "BUILD", "QA", "STAGING", "APPROVE", "DEPLOY", "CLOSED"] as const;
export type PassStage = (typeof PASS_STAGES)[number];

export type ChangeClass = "minor" | "major";

export interface PassLogEntry {
  at: string;
  stage: PassStage;
  event: string;
  note?: string;
}

/**
 * Which document the pass carries — ticket 031 §2. `spec` is an assembled `SiteSpec` built
 * by `next build` and shipped by wrangler; `annotated` is a hand-built site's
 * `content.json`, built and shipped by the scripts in the client's own folder.
 */
export type PassCarrier = "spec" | "annotated";

export interface PassState {
  slug: string;
  /** Absent on passes opened before 031 — they are all assembled. */
  carrier?: PassCarrier;
  /** Annotated only: the client site root holding `mockup/` and the deploy scripts. */
  siteDir?: string;
  /** Annotated only: where the built page's relative `assets/` are served from. */
  assetBase?: string;
  /** Quoted work rather than a standing link (031 §1) — no guarantee copy on APPROVE. */
  bespoke?: boolean;
  /** `change_passes.id` in D1. Null only for an offline rehearsal. */
  passId: string | null;
  paymentRef: string | null;
  klass: ChangeClass;
  quantity: number;
  contactEmail: string;
  /** The client's apex — DEPLOY re-attaches it to the new staged version. */
  domain: string;
  openedAt: string;
  /** The live `site_specs` version the pass started from. */
  baseVersion: number | null;
  /** The stage the pass is waiting to run. */
  stage: PassStage;
  /** sha256 of `spec.json` at the REVIEW gate. BUILD refuses anything else. */
  reviewedSpecHash?: string;
  /** Tree hash of `out/` as BUILD left it. QA and STAGING refuse a different tree. */
  builtTreeHash?: string;
  /** Tree hash STAGING pinned — the bytes the client is asked to approve. */
  stagedTreeHash?: string;
  /** How the client signed off. Free text, but required: APPROVE is a human gate. */
  approval?: string;
  deployedAt?: string;
  /** DEPLOY ran as a rehearsal (031 §3) — built, gated and diffed, never pushed. */
  rehearsedAt?: string;
  /** The `site_specs` version seeded after DEPLOY. Close needs it. */
  seededVersion?: number;
  log: PassLogEntry[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * The folder
 * ──────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_VAULT_ROOT = "/Volumes/Main/Developer";

export function clientDir(slug: string, vaultRoot = DEFAULT_VAULT_ROOT): string {
  return path.join(vaultRoot, "Business/clients", slug);
}

/**
 * `clients/<slug>/changes/<ISO>/` — 026 §2. Never under `analysis/`: 019 §4 reads two
 * `analysis/` folders under one client as a REVIEW rejection, and a paid pass is not one.
 */
export function changesDir(slug: string, vaultRoot?: string): string {
  return path.join(clientDir(slug, vaultRoot), "changes");
}

/** Folder-safe ISO timestamp — same shape `analysis/run.ts` uses for its run folders. */
export function passFolderName(at: Date): string {
  return at.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

export const PASS_FILES = {
  state: "pass.json",
  before: "spec.before.json",
  spec: "spec.json",
  delta: "delta.md",
  brief: "brief.json",
  artifact: "approved-artifact.json",
  qa: "qa",
} as const;

export function readPass(dir: string): PassState {
  return JSON.parse(fs.readFileSync(path.join(dir, PASS_FILES.state), "utf-8")) as PassState;
}

export function writePass(dir: string, state: PassState): void {
  fs.writeFileSync(path.join(dir, PASS_FILES.state), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Every pass folder for a client, oldest first. */
export function listPassDirs(slug: string, vaultRoot?: string): string[] {
  const root = changesDir(slug, vaultRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, PASS_FILES.state)))
    .map((e) => path.join(root, e.name))
    .sort();
}

/**
 * The one pass not yet CLOSED. Two open at once is refused rather than chosen between:
 * one Worker, one `out/`, one `approved-artifact.json` per client — a second pass in flight
 * would overwrite the first's manifest under it.
 */
export function openPassDir(slug: string, vaultRoot?: string): string | null {
  const open = listPassDirs(slug, vaultRoot).filter((d) => readPass(d).stage !== "CLOSED");
  if (open.length > 1) {
    throw new Error(
      `${slug} has ${open.length} open passes:\n  ${open.join("\n  ")}\n` +
        `Close or remove all but one — they share one Worker and one approved-artifact.json.`,
    );
  }
  return open[0] ?? null;
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ordering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Which command may run at which stage. BUILD and QA may repeat before STAGING: a failed
 * gate sends the owner back to the spec, and `reviewedSpecHash` is what decides whether
 * that edit needs REVIEW again. Nothing moves backwards past STAGING without a new pass —
 * once the client has been sent a preview, what they approve must be what STAGING pinned.
 */
const ALLOWED: Record<string, readonly PassStage[]> = {
  review: ["REVIEW", "BUILD", "QA", "STAGING"],
  build: ["BUILD", "QA", "STAGING"],
  qa: ["QA"],
  stage: ["STAGING"],
  approve: ["APPROVE"],
  deploy: ["DEPLOY"],
  close: ["CLOSED"],
};

export function assertStage(state: PassState, command: keyof typeof ALLOWED): void {
  if (command === "close") {
    // A rehearsed DEPLOY (031 §3) never seeds, because seeding a version the live site
    // does not serve would make `liveVersion` lie. It still has to be closeable, or the
    // client stays locked out over work that was never pushed — so it closes as abandoned.
    if (state.seededVersion === undefined && !state.rehearsedAt) {
      throw new Error(
        `close needs the seeded spec version — run \`deploy\` to completion first (pass is at ${state.stage}).`,
      );
    }
    return;
  }
  if (!ALLOWED[command].includes(state.stage)) {
    throw new Error(
      `\`${command}\` cannot run while the pass is at ${state.stage}. ` +
        `Next: \`${nextCommand(state.stage)}\`.`,
    );
  }
}

export function nextCommand(stage: PassStage): string {
  switch (stage) {
    case "REVIEW":
      return "review --approve";
    case "BUILD":
      return "build";
    case "QA":
      return "qa";
    case "STAGING":
      return "stage";
    case "APPROVE":
      return 'approve --evidence "<how the client signed off>"';
    case "DEPLOY":
      return "deploy";
    case "CLOSED":
      return "nothing — the pass is closed";
  }
}

export function advance(state: PassState, to: PassStage, event: string, note?: string): PassState {
  return {
    ...state,
    stage: to,
    log: [...state.log, { at: new Date().toISOString(), stage: to, event, ...(note ? { note } : {}) }],
  };
}

export function logEvent(state: PassState, event: string, note?: string): PassState {
  return {
    ...state,
    log: [...state.log, { at: new Date().toISOString(), stage: state.stage, event, ...(note ? { note } : {}) }],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The delta — REVIEW's flags sheet
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DeltaEntry {
  path: string;
  change: "changed" | "added" | "removed" | "membership";
  /** On the free side of 012's partition — work the client could have done themselves. */
  free: boolean;
  before?: unknown;
  after?: unknown;
}

/**
 * Leaf diff between the live spec and the working one.
 *
 * Arrays of unequal length report once, at the array, as `membership`: an insert at index
 * 0 otherwise reports every later element as "changed", which is noise on exactly the
 * major tickets that most need a readable sheet. Membership of `pages` / `sections` is paid
 * (012: page and section membership, and section order); list membership under a section's
 * `props` is the free floor (012: list item add/remove with a ≥1 floor).
 */
export function diffSpecs(before: unknown, after: unknown, at = ""): DeltaEntry[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [
        {
          path: at,
          change: "membership",
          free: isFreeMembership(at),
          before: `${before.length} item(s)`,
          after: `${after.length} item(s)`,
        },
      ];
    }
    return before.flatMap((item, i) => diffSpecs(item, after[i], `${at}[${i}]`));
  }

  if (isRecord(before) && isRecord(after)) {
    // A section whose `type` changed is a different section — a reorder or a replacement —
    // not a set of prop edits. Reported leaf by leaf, its props would all read as free.
    if (typeof before.type === "string" && typeof after.type === "string" && before.type !== after.type) {
      return [{ path: at, change: "changed", free: false, before: `section: ${before.type}`, after: `section: ${after.type}` }];
    }
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const child = at ? `${at}.${key}` : key;
      if (!(key in before)) return [{ path: child, change: "added" as const, free: isFreePath(child), after: after[key] }];
      if (!(key in after)) return [{ path: child, change: "removed" as const, free: isFreePath(child), before: before[key] }];
      return diffSpecs(before[key], after[key], child);
    });
  }

  return [{ path: at, change: "changed", free: isFreePath(at), before, after }];
}

function isFreeMembership(arrayPath: string): boolean {
  if (!/\.props\./.test(arrayPath)) return false;
  // Any link array stays paid, same as the partition's leaf rule.
  return isFreePath(`${arrayPath}[0].title`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return "—";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
}

export interface Brief {
  /** `change_requests` rows the payment was linked to, and any still open. */
  requests: Array<{ label: string; klass: string; action: string; target: string; note: string | null; status: string; created_at: string }>;
  /** The client's unpublished draft at the moment the pass opened, if it differs from live. */
  dirtyDraft: { baseVersion: number; updatedAt: string; delta: DeltaEntry[] } | null;
}

/**
 * 026 §1 step 2: *the flags sheet is a delta, not the first-run "wrong site?" sheet.* So
 * it says what the pass changes and flags only what a pass can get wrong: shipping no paid
 * change at all, and the client's draft that will be dropped at close.
 */
export function renderDelta(state: PassState, delta: DeltaEntry[], brief: Brief | null): string {
  const paid = delta.filter((d) => !d.free);
  const free = delta.filter((d) => d.free);
  const row = (d: DeltaEntry) => `| \`${d.path || "(root)"}\` | ${d.change} | ${show(d.before)} | ${show(d.after)} |`;
  const table = (items: DeltaEntry[]) =>
    ["| Path | Change | Before | After |", "|---|---|---|---|", ...items.map(row)].join("\n");

  const flags: string[] = [];
  if (delta.length === 0) flags.push("- **No change.** `spec.json` equals the live spec — nothing to build.");
  else if (paid.length === 0)
    flags.push(
      "- **No paid path changed.** Everything here is on the free side of the partition — " +
        "the client could have done it in the editor. Confirm the ticket was needed.",
    );
  if (brief?.dirtyDraft) {
    flags.push(
      `- **The client has an unpublished draft** (forked from v${brief.dirtyDraft.baseVersion}, ` +
        `saved ${brief.dirtyDraft.updatedAt}, ${brief.dirtyDraft.delta.length} change(s)). ` +
        "It is dropped when the pass closes — fold what should survive into `spec.json` now.",
    );
  }
  if (state.klass === "minor" && paid.some((d) => d.change === "membership" || /\.type$/.test(d.path))) {
    flags.push(
      "- **Structural change on a minor ticket.** Section membership, order and `type` are major " +
        "(012). Check the class before BUILD — QA runs the full suite on major only.",
    );
  }

  const requests = brief?.requests ?? [];
  return [
    `# Change pass — ${state.slug}`,
    "",
    `Opened ${state.openedAt} · ${state.klass} × ${state.quantity} · pass \`${state.passId ?? "offline"}\` · ` +
      `from live v${state.baseVersion ?? "?"}`,
    "",
    "## Flags",
    "",
    flags.length ? flags.join("\n") : "- None.",
    "",
    "## Requests",
    "",
    requests.length
      ? requests
          .map((r) => `- **${r.label}** (${r.klass}, ${r.status}) — \`${r.target}\`${r.note ? ` — “${r.note}”` : ""}`)
          .join("\n")
      : "- None recorded. The client paid from a bare link, or the pass was recorded by hand.",
    "",
    `## Paid paths (${paid.length})`,
    "",
    paid.length ? table(paid) : "- None.",
    "",
    `## Free paths (${free.length})`,
    "",
    free.length ? table(free) : "- None.",
    "",
    ...(brief?.dirtyDraft?.delta.length
      ? ["## The client's draft, against live", "", table(brief.dirtyDraft.delta), ""]
      : []),
  ].join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * state.md — proposed, never written
 * ──────────────────────────────────────────────────────────────────────────── */

/** `key: "value"` lines between the first pair of `---`. Enough for the fields read here. */
export function readFrontmatter(stateMd: string): Record<string, string> {
  const match = stateMd.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/**
 * Client `state.md` is propose-class and its Stage Log is append-only by hand
 * (`Business/CLAUDE.md`), so the runner prints the diff and the row and the owner pastes
 * them — the same convention `deploy.ts` uses for `approve-entered`.
 */
export function stateProposal(
  current: Record<string, string>,
  next: Partial<Record<"stage" | "relationship" | "substatus", string>>,
  note: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = ["Propose for state.md (propose-class — paste by hand):"];
  for (const [key, value] of Object.entries(next)) {
    if (current[key] === value) continue;
    lines.push(`  - ${key}: "${current[key] ?? ""}"`, `  + ${key}: "${value}"`);
  }
  lines.push(`  + updated: "${today}"`);
  const from = current.stage ?? "";
  const to = next.stage ?? from;
  lines.push("  Stage Log row:", `  | ${today} | ${from} | ${to} | change-runner | ${note} |`);
  return lines.join("\n");
}

/** Passes written before 031 carry no `carrier` field, and every one of them is assembled. */
export function carrierOf(state: PassState): PassCarrier {
  return state.carrier ?? "spec";
}
