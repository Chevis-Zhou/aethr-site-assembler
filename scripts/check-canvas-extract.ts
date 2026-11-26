import * as fs from "node:fs";
import * as path from "node:path";

import { render } from "../src/lib/edit/annotation-template";
import { buildAnnotatedInventory } from "../src/lib/edit/annotation-adapter";
import { attr, scan, tree, walk, type Element } from "../src/lib/edit/html-scan";
import type { FieldInventory, InventoryField } from "../src/lib/edit/inventory";

/**
 * Proves that a canvas edit and a Style-panel edit save the same thing.
 *
 * The self-edit tool now has two ways to change a word. The panel writes the string the
 * client typed into a control. The canvas writes the string it reads back out of the
 * rendered page, because that is where they typed it. Those agree only if rendering a
 * value and reading it back is the identity — and it is not, in general: a `text-transform`
 * hands back different characters, collapsed whitespace eats a double space, and a template
 * that puts decoration beside the token (`<h2>{{heading}}<span>.</span></h2>`) would hand
 * back the decoration as part of the heading.
 *
 * So this renders the pilot and, for every text and link field, extracts the value the way
 * `canvas-text.ts` does at runtime — the `data-ae-slot` descendant if there is one, else the
 * annotated element's own first non-whitespace text node (`edit-layer/SPEC.md` §4) — and
 * compares it with what the reader says is stored. A mismatch is not a failure of this
 * check: it is a field the canvas must refuse, and the editor does refuse it, falling back
 * to the panel. What this catches is the *count* going up, which means a template change
 * quietly moved a field out of reach of the primary editing surface.
 *
 *   npx tsx scripts/check-canvas-extract.ts [--dir <mockup dir>]
 */

const DEFAULT_DIR =
  "/Volumes/Main/Developer/Business/clients/max-maxematics/MaxTutoring/mockup";

/** Fields whose rendered text is legitimately not their stored text. Keep this empty. */
const EXPECTED_FALLBACKS: string[] = [];

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const dir = arg("dir", DEFAULT_DIR);
const templatePath = path.join(dir, "template.html");
const contentPath = path.join(dir, "content.json");

if (!fs.existsSync(templatePath) || !fs.existsSync(contentPath)) {
  console.log(`check-canvas-extract: no annotated site at ${dir} — skipped.`);
  process.exit(0);
}

const templateHtml = fs.readFileSync(templatePath, "utf8");
const content = JSON.parse(fs.readFileSync(contentPath, "utf8")) as Record<string, unknown>;
const html = render(templateHtml, content);
const inventory: FieldInventory = buildAnnotatedInventory(templateHtml, content, "check");

const fields = new Map<string, InventoryField>();
for (const group of [inventory.site, ...inventory.pages.flatMap((page) => page.groups)]) {
  for (const field of group.fields) fields.set(field.id, field);
}

const { root } = tree(scan(html), html);

/** The text that belongs to `el` itself rather than to one of its children, in order. */
function directText(el: Element): string[] {
  const segments: string[] = [];
  let at = el.contentStart;
  for (const child of el.children) {
    const start = child.open?.start ?? at;
    if (start > at) segments.push(html.slice(at, start));
    at = child.close?.end ?? child.open?.end ?? at;
  }
  if (el.contentEnd > at) segments.push(html.slice(at, el.contentEnd));
  return segments;
}

function decode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** What the browser's `innerText` would give the canvas for this field. */
function renderedValue(el: Element, slot: "value" | "label"): string | null {
  for (const candidate of walk(el)) {
    if (attr(candidate, "data-ae-slot") !== slot) continue;
    // Only this annotation's slots — a nested annotation carries its own.
    let owner: Element | null = candidate.parent;
    while (owner && attr(owner, "data-ae") === undefined) owner = owner.parent;
    if (owner === el) return decode(directText(candidate).join(""));
  }
  const first = directText(el).find((segment) => segment.trim() !== "");
  return first === undefined ? null : decode(first);
}

const problems: string[] = [];
let checked = 0;

for (const el of walk(root)) {
  const pathAttr = attr(el, "data-ae");
  const type = attr(el, "data-ae-type");
  if (!pathAttr || !type) continue;
  if (type !== "text" && type !== "link") continue;

  const id = type === "link" ? `${pathAttr}.label` : pathAttr;
  const field = fields.get(id);
  if (!field) continue;

  const rendered = renderedValue(el, type === "link" ? "label" : "value");
  checked += 1;
  if (rendered === null) {
    problems.push(`${id}: nothing rendered to read back`);
    continue;
  }
  if (rendered.trim() !== field.value.trim()) {
    problems.push(
      `${id}: page shows ${JSON.stringify(rendered.trim())}, content.json holds ${JSON.stringify(
        field.value.trim(),
      )}`,
    );
  }
}

const unexpected = problems.filter(
  (problem) => !EXPECTED_FALLBACKS.some((id) => problem.startsWith(`${id}:`)),
);

console.log(`check-canvas-extract: ${checked} text and link fields read back from the page.`);
if (unexpected.length === 0) {
  console.log("check-canvas-extract: every one round-trips — the canvas and the panel agree.");
  process.exit(0);
}

console.error(
  `check-canvas-extract: ${unexpected.length} field(s) the canvas cannot write back.\n` +
    "The editor falls back to the Style panel for these, so nothing is broken — but a field\n" +
    "that used to round-trip and no longer does is a template change worth looking at.\n",
);
for (const problem of unexpected) console.error(`  · ${problem}`);
process.exit(1);
