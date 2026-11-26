import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { render } from "../src/lib/edit/annotation-template";
import { buildAnnotatedInventory, annotatedWritePaths } from "../src/lib/edit/annotation-adapter";
import { applyAnnotatedEdits } from "../src/lib/edit/annotation-apply";

/**
 * Proves reader #2 against the only annotated site there is — ticket 012's Maxematics
 * pilot — and proves the TypeScript renderer byte-identical to the `.mjs` one the pilot's
 * deploy actually runs.
 *
 * That second half is the point. `annotation-template.ts` and `html-scan.ts` are ports, and
 * a port is a second implementation that can drift. This makes "they agree" a checked
 * claim: it renders `template.html` + `content.json` through the TypeScript path and
 * diffs the result against what `edit-layer/build.mjs` wrote. A difference means the
 * editor's preview and the client's live page disagree, which is the one property the
 * whole preview design exists to guarantee.
 *
 *   npx tsx scripts/check-annotated-parity.ts [--dir <mockup dir>]
 */

const DEFAULT_DIR =
  "/Volumes/Main/Developer/Business/clients/max-maxematics/MaxTutoring/mockup";

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const dir = arg("dir", DEFAULT_DIR);
const templatePath = path.join(dir, "template.html");
const contentPath = path.join(dir, "content.json");
const builtPath = path.join(dir, "index.html");

if (!fs.existsSync(templatePath) || !fs.existsSync(contentPath)) {
  console.log(`check-annotated-parity: no annotated site at ${dir} — skipped.`);
  process.exit(0);
}

const templateHtml = fs.readFileSync(templatePath, "utf-8");
const content = JSON.parse(fs.readFileSync(contentPath, "utf-8")) as Record<string, unknown>;

/* ── 1. renderer parity ──────────────────────────────────────────────────── */

// Rebuild through the reference implementation first, so the comparison is against a
// current artifact rather than whatever was last committed.
const buildScript = path.join(dir, "..", "edit-layer", "build.mjs");
if (fs.existsSync(buildScript)) {
  execFileSync("node", [buildScript, "--dir", dir], { stdio: "pipe" });
}

const ours = render(templateHtml, content);
const theirs = fs.readFileSync(builtPath, "utf-8");

if (ours !== theirs) {
  const at = [...ours].findIndex((char, index) => char !== theirs[index]);
  console.error("check-annotated-parity: FAIL — the TypeScript renderer and build.mjs disagree.");
  console.error(`  first difference at byte ${at}`);
  console.error(`  ts : ${JSON.stringify(ours.slice(Math.max(0, at - 60), at + 60))}`);
  console.error(`  mjs: ${JSON.stringify(theirs.slice(Math.max(0, at - 60), at + 60))}`);
  process.exit(1);
}
console.log(`renderer parity: OK (${ours.length} bytes identical)`);

/* ── 2. the inventory reader ─────────────────────────────────────────────── */

const inventory = buildAnnotatedInventory(templateHtml, content, "max-maxematics");
const groups = [inventory.site, ...inventory.pages[0].groups];
const fields = groups.reduce((n, group) => n + group.fields.length, 0);
const lists = groups.reduce((n, group) => n + group.lists.length, 0);

console.log(
  `inventory: ${fields} free fields, ${lists} editable lists, ${groups.length} groups, ` +
    `${inventory.locked.length} priced controls`,
);
for (const group of groups) {
  console.log(
    `  ${group.label.padEnd(16)} ${String(group.fields.length).padStart(2)} fields` +
      (group.lists.length ? ` · ${group.lists.map((l) => l.label).join(", ")}` : ""),
  );
}

/* ── 3. the write path, including the refusals ───────────────────────────── */

const writable = annotatedWritePaths(inventory);
const checks: [string, boolean][] = [];

const heading = [...writable].find((p) => p.endsWith("difference.heading"));
if (heading) {
  const ok = applyAnnotatedEdits(content, inventory, templateHtml, [
    { op: "set", path: heading, value: "The Maxematics Way" },
  ]);
  checks.push(["free field saves", ok.ok]);
}

const forbidden = applyAnnotatedEdits(content, inventory, templateHtml, [
  { op: "set", path: "site.somethingNobodyAnnotated", value: "x" },
]);
checks.push(["unannotated path refused", !forbidden.ok && forbidden.failure.reason === "forbidden"]);

const overLong = applyAnnotatedEdits(content, inventory, templateHtml, [
  { op: "set", path: "difference.eyebrow", value: "x".repeat(400) },
]);
checks.push(["data-ae-max enforced", !overLong.ok && overLong.failure.reason === "invalid"]);

const badScheme = applyAnnotatedEdits(content, inventory, templateHtml, [
  { op: "set", path: "contact.email.href", value: "javascript:alert(1)" },
]);
checks.push(["link scheme allowlist enforced", !badScheme.ok]);

const goodScheme = applyAnnotatedEdits(content, inventory, templateHtml, [
  { op: "set", path: "contact.email.href", value: "mailto:hello@example.com" },
]);
checks.push(["allowed scheme saves", goodScheme.ok]);

const added = applyAnnotatedEdits(content, inventory, templateHtml, [
  { op: "list-add", path: "rates.rows" },
]);
checks.push(["list add renders", added.ok]);

// Down to the floor, then one past it.
let shrinking: Record<string, unknown> = content;
let floorHit = false;
for (let i = 0; i < 12; i++) {
  const step = applyAnnotatedEdits(
    shrinking,
    buildAnnotatedInventory(templateHtml, shrinking, "max-maxematics"),
    templateHtml,
    [{ op: "list-remove", path: "topics.railA", index: 0 }],
  );
  if (!step.ok) {
    floorHit = step.failure.reason === "floor";
    break;
  }
  shrinking = step.content;
}
checks.push(["list floor blocks the last removals", floorHit]);

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
}
console.log(`write path: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
