import { readDeclarations, type Declaration } from "./shared/declarations.mjs";
import { parseBundle, assertBundleContent } from "./shared/bundle.mjs";
import { getPath } from "./annotation-template";
import {
  CHANGE_PRICE_CENTS,
  type FieldConstraints,
  type FieldInventory,
  type FieldKind,
  type InventoryField,
  type InventoryGroup,
  type InventoryList,
  type LockedControl,
} from "./inventory";

/**
 * Reader #2 — the annotation manifest, for hand-built sites.
 *
 * Ticket 012's 2026-09-09 amendment §A: there is ONE backend, and three leaves vary inside
 * it. This is the second of the three — the same `FieldInventory` the editor already
 * consumes, produced from `template.html` + `content.json` instead of from `SiteSpec`. The
 * editor UI is not touched by this file existing, which was the amendment's stated reason
 * for designing the seam before v1's UI was built.
 *
 * **The partition is the annotation itself** (amendment §B). On the assembled side the
 * free/paid line is a rule over paths; here the developer drew it when they decided what to
 * mark up, and `edit-layer/SPEC.md` §11's authoring doctrine — *"annotate less than you
 * can"* — turns out to be the pricing boundary in disguise. So this file has no
 * classification rules of its own, and adding one would be a second boundary.
 *
 * Vocabulary and constraints: `edit-layer/SPEC.md` v1. Anything this reader does not
 * understand is a refusal, never a shrug (§2 of that spec) — an unknown `data-ae-v` throws
 * rather than degrading, because a silently-ignored constraint is how a client uploads a
 * 4000px image into a slot that declared a limit.
 */

export const ANNOTATION_VERSION = 1;

type AnnotationType = Declaration["type"];
type FieldSpec = Omit<Declaration, "schemes" | "fields"> & {
  schemes?: string[];
  fields?: Record<string, FieldSpec>;
};
export class AnnotationError extends Error {}
const DEFAULT_SCHEMES = ["https", "mailto", "tel", "anchor"];

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the declaration
 * ──────────────────────────────────────────────────────────────────────────── */

export function readAnnotations(templateHtml: string): Map<string, FieldSpec> {
  try {
    const normalize = (spec: Declaration): FieldSpec => ({
      ...spec,
      schemes: typeof spec.schemes === "string" ? spec.schemes.split(",").map(value => value.trim()) : spec.schemes,
      fields: spec.fields ? Object.fromEntries(Object.entries(spec.fields).map(([key, value]) => [key, normalize(value)])) : undefined,
    });
    return new Map([...readDeclarations(templateHtml)].map(([path, spec]) => [path, normalize(spec)]));
  } catch (error) {
    throw new AnnotationError((error as Error).message);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Building the inventory
 * ──────────────────────────────────────────────────────────────────────────── */

function labelFor(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "Testimonials" → "testimonial". Crude on purpose; a manifest `label` overrides it. */
function singular(plural: string): string {
  const lower = plural.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

function kindFor(spec: FieldSpec): FieldKind {
  if (spec.type === "richtext") return "richtext";
  return spec.multiline || (spec.max ?? 0) > 160 ? "textarea" : "text";
}

function constraintsFor(spec: FieldSpec, required: boolean): FieldConstraints {
  const constraints: FieldConstraints = { required };
  if (spec.max !== undefined) constraints.maxLength = spec.max;
  if (spec.min !== undefined) constraints.minLength = spec.min;
  return constraints;
}

/**
 * `difference.eyebrow` sits in group `difference`; a manifest `group` overrides it.
 *
 * The first path segment is the group because that is how these documents are actually
 * shaped — one key per section of the page — and it is the only grouping available without
 * asking the developer to annotate a second thing. A generator emitting this format gets
 * grouping for free by naming its keys after its sections.
 */
function groupKeyOf(spec: FieldSpec): string {
  // Normalised, because the two carriers name the same group differently: an inline
  // annotation's group is its first path segment (`testimonials`) while the manifest spells
  // it for a human (`"Testimonials"`). Left as typed, the pilot produced two groups called
  // Testimonials and an empty site group beside a populated one called Site.
  return (spec.group ?? spec.path.split(".")[0]).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

interface Draft {
  id: string;
  label: string;
  fields: InventoryField[];
  lists: InventoryList[];
}

function buildPageInventory(
  templateHtml: string,
  content: unknown,
  slug: string,
): FieldInventory {
  const specs = readAnnotations(templateHtml);
  const groups = new Map<string, Draft>();

  const groupFor = (spec: FieldSpec): Draft => {
    const key = groupKeyOf(spec);
    let draft = groups.get(key);
    if (!draft) {
      draft = { id: key, label: labelFor(key), fields: [], lists: [] };
      groups.set(key, draft);
    }
    // A manifest `group` is a human-written name; it wins over one derived from a path.
    if (spec.group) draft.label = spec.group;
    return draft;
  };

  const push = (draft: Draft, field: InventoryField) => {
    if (getPath(content, field.id) === undefined) {
      // SPEC §10: an annotation with no matching content key is a build failure. It cannot
      // reach a deployed page, and rendering a control over a key that does not exist would
      // give the client a field whose every save is refused.
      return;
    }
    draft.fields.push(field);
  };

  for (const spec of specs.values()) {
    if (spec.type === "internal") continue;
    const draft = groupFor(spec);
    const base = spec.label ?? labelFor(spec.path.split(".").slice(1).join(".") || spec.path);

    if (spec.type === "list") {
      const items = getPath(content, spec.path);
      if (!Array.isArray(items)) continue;
      const label = spec.label ?? labelFor(spec.path.split(".").pop() ?? spec.path);

      draft.lists.push({
        id: spec.path,
        label,
        itemLabel: singular(label),
        count: items.length,
        min: spec.minItems ?? 1,
        max: spec.maxItems,
        template: blankItemLike(items[0], spec.fields),
      });

      items.forEach((item, index) => {
        for (const [key, value] of Object.entries((item ?? {}) as Record<string, unknown>)) {
          const declared = spec.fields?.[key];
          if (declared?.type === "internal") continue;
          pushLeaf(draft, `${spec.path}.${index}.${key}`, value, declared ?? { path: key, type: inferType(value) }, push);
        }
      });
      continue;
    }

    pushLeaf(draft, spec.path, getPath(content, spec.path), { ...spec, label: base }, push);
  }

  const groupList: InventoryGroup[] = [...groups.values()]
    .filter((draft) => draft.fields.length > 0 || draft.lists.length > 0)
    .map((draft) => ({
      id: draft.id,
      label: draft.label,
      kind: "section" as const,
      sectionType: draft.id,
      fields: draft.fields,
      lists: draft.lists,
      locked: [],
    }));

  // A hand-built page has no enumerable section list to price a move or a swap against, so
  // the boundary is stated once at the page level rather than invented per group. Both
  // classes are offered because both are real: a sentence the developer did not annotate is
  // the $100 case, and a new block or a layout change is the $300 one.
  const locked: LockedControl[] = [
    {
      action: "change-option",
      label: "Change something the editor cannot reach",
      klass: "minor",
      priceCents: CHANGE_PRICE_CENTS.minor,
      target: slug,
    },
    {
      action: "add-section",
      label: "Add a block, or change the layout",
      klass: "major",
      priceCents: CHANGE_PRICE_CENTS.major,
      target: slug,
    },
  ];

  // `site.*` is the site-wide half — browser tab title, search-result description — and it
  // renders above the page list, the same place `client.*` and `seo.*` render for an
  // assembled site. A page with no `site.*` keys simply has an empty one.
  const site: InventoryGroup = groupList.find((group) => group.id === "site") ?? {
    id: "site",
    label: "Your details",
    kind: "site",
    fields: [],
    lists: [],
    locked: [],
  };
  site.kind = "site";
  site.label = "Your details";

  return {
    kind: "annotated",
    slug,
    site,
    pages: [
      {
        id: "page",
        slug: "/",
        label: String(getPath(content, "site.title") ?? slug),
        groups: groupList.filter((group) => group.id !== "site"),
        locked: [],
      },
    ],
    locked,
  };
}

/** Route-aware inventory; a legacy template stays the original single page. */
export function buildAnnotatedInventory(templateHtml: string, content: unknown, slug: string): FieldInventory {
  const bundle = parseBundle(templateHtml);
  assertBundleContent(templateHtml, content);
  const inventories = bundle.pages.map(page => buildPageInventory(page.html, content, slug));
  if (bundle.pages.length === 1 && bundle.mode === "html" && !templateHtml.trimStart().startsWith("{")) return inventories[0];
  const site = { ...inventories[0].site, fields: [] as InventoryField[], lists: [] as InventoryList[] };
  const fields = new Set<string>(), lists = new Set<string>();
  for (const inventory of inventories) {
    for (const field of inventory.site.fields) if (!fields.has(field.id)) { site.fields.push(field); fields.add(field.id); }
    for (const list of inventory.site.lists) if (!lists.has(list.id)) { site.lists.push(list); lists.add(list.id); }
  }
  return {
    ...inventories[0], site,
    pages: inventories.map((inventory, index) => ({
      ...inventory.pages[0], id: bundle.pages[index].id, slug: bundle.pages[index].slug,
      label: bundle.pages[index].label,
      groups: inventory.pages[0].groups.map(group => ({...group, id: `${bundle.pages[index].id}:${group.id}`})),
    })),
  };
}

/** One leaf, expanded into the controls its declared type actually needs. */
function pushLeaf(
  draft: Draft,
  path: string,
  value: unknown,
  spec: FieldSpec,
  push: (draft: Draft, field: InventoryField) => void,
): void {
  const label = spec.label ?? labelFor(path.split(".").pop() ?? path);

  if (spec.type === "image") {
    // `{ src, alt }` — always an object, even where the page ignores `alt` (SPEC §5). The
    // assembled side has to borrow a sibling text field for alt text because no image leaf
    // in `SiteSpec` carries one; here it is a real key, so it gets a real control.
    push(draft, {
      id: `${path}.src`,
      kind: "image",
      label,
      value: String(getPath({ v: value }, "v.src") ?? ""),
      constraints: { required: true, altPath: `${path}.alt` },
    });
    push(draft, {
      id: `${path}.alt`,
      kind: "text",
      label: `${label} — description for screen readers`,
      value: String(getPath({ v: value }, "v.alt") ?? ""),
      constraints: { required: spec.altRequired ?? false },
    });
    return;
  }

  if (spec.type === "link") {
    push(draft, {
      id: `${path}.label`,
      kind: "text",
      label,
      value: String(getPath({ v: value }, "v.label") ?? ""),
      constraints: constraintsFor(spec, true),
    });
    push(draft, {
      id: `${path}.href`,
      kind: "url",
      label: `${label} — where it goes`,
      value: String(getPath({ v: value }, "v.href") ?? ""),
      constraints: { required: true, schemes: spec.schemes ?? DEFAULT_SCHEMES },
    });
    return;
  }

  push(draft, {
    id: path,
    kind: kindFor(spec),
    label,
    value: value === null || value === undefined ? "" : String(value),
    constraints: constraintsFor(spec, true),
  });
}

function inferType(value: unknown): AnnotationType {
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.includes("src")) return "image";
    if (keys.includes("href")) return "link";
  }
  return "text";
}

/**
 * A new list item shaped like the ones already there — SPEC §5 makes uniform key sets a
 * validator error, so copying item 0's shape is the only shape that can be right.
 */
function blankItemLike(
  sample: unknown,
  declared: Record<string, FieldSpec> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((sample ?? {}) as Record<string, unknown>)) {
    if (declared?.[key]?.type === "internal") {
      // `internal` keys are injected by the build and invisible to the client, so a new
      // item still needs one — carried forward from the sibling rather than blanked.
      out[key] = String(value ?? "");
      continue;
    }
    out[key] = typeof value === "string" ? "" : JSON.stringify(blankShape(value));
  }
  return out;
}

function blankShape(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((key) => [key, ""]),
    );
  }
  return "";
}

/**
 * The write set — every path the inventory actually renders a control for.
 *
 * This IS the partition for annotated sites, computed from the same inventory the editor
 * received rather than from a second rule. `annotation-apply.ts` re-checks against it
 * server-side for the same reason `isFreePath` is re-checked there: a POST is a POST, and
 * this boundary is also the price list.
 */
export function annotatedWritePaths(inventory: FieldInventory): Set<string> {
  const paths = new Set<string>();
  const groups = [inventory.site, ...inventory.pages.flatMap((page) => page.groups)];
  for (const group of groups) {
    for (const field of group.fields) paths.add(field.id);
    for (const list of group.lists) paths.add(list.id);
  }
  return paths;
}
