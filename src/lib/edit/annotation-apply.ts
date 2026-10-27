import type { EditOp, ApplyFailure } from "./apply";
import type { FieldInventory, InventoryField, InventoryList } from "./inventory";
import { annotatedWritePaths, buildAnnotatedInventory } from "./annotation-adapter";
import { getPath, setPath, TemplateError } from "./annotation-template";
import { assertBundleContent } from "./shared/bundle.mjs";
import { richTextToPlainText, sanitizeRichText } from "../rich-text";

/**
 * The write path for annotated sites — the second build recipe's half of one backend.
 *
 * Mirrors `apply.ts` operation for operation, and for the same reasons: the editor renders
 * only what the inventory contains, but a POST is a POST, so every operation is re-checked
 * here against the same inventory the client was served. Nothing is written in place —
 * each operation clones, applies, and then **re-renders the whole page through the real
 * renderer**. That is the annotated analogue of re-parsing against `siteSpecSchema`: an
 * edit that would produce a page `build.mjs` cannot render is refused in the editor, where
 * the client can see it, rather than at the gate five minutes later.
 */

export type AnnotatedApplyResult =
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; failure: ApplyFailure };

function fail(
  reason: ApplyFailure["reason"],
  path: string,
  message: string,
): { ok: false; failure: ApplyFailure } {
  return { ok: false, failure: { reason, message, path } };
}

/** Resolves the control a path belongs to, list items included. */
function fieldFor(inventory: FieldInventory, path: string): InventoryField | undefined {
  const groups = [inventory.site, ...inventory.pages.flatMap((page) => page.groups)];
  for (const group of groups) {
    const direct = group.fields.find((field) => field.id === path);
    if (direct) return direct;
  }
  return undefined;
}

function listFor(inventory: FieldInventory, path: string): InventoryList | undefined {
  const groups = [inventory.site, ...inventory.pages.flatMap((page) => page.groups)];
  for (const group of groups) {
    const hit = group.lists.find((list) => list.id === path);
    if (hit) return hit;
  }
  return undefined;
}

/** `https://x` → `https`, `#faq` → `anchor`, `about.html` → `relative`. */
function schemeOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return "anchor";
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  return match ? match[1].toLowerCase() : "relative";
}

function checkValue(field: InventoryField, value: string): string | ApplyFailure {
  const { constraints } = field;

  if (field.kind === "url") {
    const scheme = schemeOf(value);
    const allowed = constraints.schemes ?? [];
    if (!allowed.includes(scheme)) {
      return {
        reason: "invalid",
        path: field.id,
        // The allowlist is a security control, not a convenience — this writes into a file
        // served from the client's own domain (SPEC §5).
        message: `That link has to start with ${allowed
          .filter((s) => s !== "relative" && s !== "anchor")
          .map((s) => `${s}:`)
          .join(", ")}.`,
      };
    }
    return value.trim();
  }

  const stored = field.kind === "richtext" ? sanitizeRichText(value) : value;
  // `max` counts the *rendered* text, not the markup (SPEC §5) — otherwise a paragraph
  // with two bold words spends its budget on `<strong>`.
  const counted = field.kind === "richtext" ? richTextToPlainText(stored) : stored;

  if (constraints.maxLength !== undefined && counted.length > constraints.maxLength) {
    return {
      reason: "invalid",
      path: field.id,
      message: `${field.label} has a limit of ${constraints.maxLength} characters — that is ${counted.length}.`,
    };
  }
  if (constraints.minLength !== undefined && counted.length < constraints.minLength) {
    return {
      reason: "invalid",
      path: field.id,
      message: `${field.label} needs at least ${constraints.minLength} characters.`,
    };
  }
  if (constraints.required && counted.trim() === "") {
    return { reason: "invalid", path: field.id, message: `${field.label} cannot be empty.` };
  }
  return stored;
}

export function applyAnnotatedEdit(
  current: Record<string, unknown>,
  inventory: FieldInventory,
  templateHtml: string,
  edit: EditOp,
): AnnotatedApplyResult {
  const next = structuredClone(current);
  const writable = annotatedWritePaths(inventory);

  if (edit.op === "set") {
    const field = fieldFor(inventory, edit.path);
    if (!field) {
      // Not annotated, therefore not free — amendment §B, and the whole partition for this
      // carrier. There is no second rule to consult.
      return fail("forbidden", edit.path, "That change is a change ticket, not a free edit.");
    }
    if (getPath(next, edit.path) === undefined) {
      return fail("missing", edit.path, "That field no longer exists on your site.");
    }

    const checked = checkValue(field, edit.value);
    if (typeof checked !== "string") return { ok: false, failure: checked };

    if (field.constraints.altPath && checked !== "") {
      const alt = String(getPath(next, field.constraints.altPath) ?? "").trim();
      if (alt === "") {
        return fail(
          "alt-required",
          edit.path,
          "Add a description for this image first — it is what screen readers announce.",
        );
      }
    }

    try {
      setPath(next, edit.path, checked);
    } catch (err) {
      return fail("missing", edit.path, (err as Error).message);
    }
  }

  if (edit.op === "list-add" || edit.op === "list-remove") {
    const list = listFor(inventory, edit.path);
    if (!list || !writable.has(edit.path)) {
      return fail("forbidden", edit.path, "That list is not editable on your plan.");
    }
    const items = getPath(next, edit.path);
    if (!Array.isArray(items)) {
      return fail("missing", edit.path, "That list no longer exists on your site.");
    }

    if (edit.op === "list-add") {
      if (list.max !== undefined && items.length >= list.max) {
        return fail("floor", edit.path, `This section holds at most ${list.max} ${list.label.toLowerCase()}.`);
      }
      items.push(reviveTemplate(list.template));
    } else {
      if (items.length <= list.min) {
        return fail(
          "floor",
          edit.path,
          list.min === 1
            ? "A section needs at least one item."
            : `This section needs at least ${list.min} ${list.label.toLowerCase()}.`,
        );
      }
      if (edit.index < 0 || edit.index >= items.length) {
        return fail("missing", edit.path, "That item is already gone.");
      }
      items.splice(edit.index, 1);
    }
  }

  // The re-parse. A page that no longer renders is refused before it is stored.
  try {
    assertBundleContent(templateHtml, next);
  } catch (err) {
    const message = err instanceof TemplateError ? err.message : String(err);
    return fail("invalid", edit.path, message);
  }

  return { ok: true, content: next };
}

/** The list template carries nested shapes as JSON strings; put them back as objects. */
function reviveTemplate(template: Record<string, string>): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        item[key] = JSON.parse(value);
        continue;
      } catch {
        /* fall through — it was a string that happened to start with a brace */
      }
    }
    item[key] = value;
  }
  return item;
}

/** Applies a batch, stopping at the first failure so a partial write is never persisted. */
export function applyAnnotatedEdits(
  current: Record<string, unknown>,
  inventory: FieldInventory,
  templateHtml: string,
  edits: EditOp[],
): AnnotatedApplyResult {
  let content = current;
  let against = inventory;
  for (const edit of edits) {
    const result = applyAnnotatedEdit(content, against, templateHtml, edit);
    if (!result.ok) return result;
    content = result.content;
    // A list that just grew or shrank has different fields in it, and the partition is
    // read off the inventory — so an edit to an item added earlier in the *same* batch
    // would otherwise be refused as "a change ticket, not a free edit". Rebuilt only when
    // the shape changed, because it re-parses the template and a `set` cannot change it.
    if (edit.op !== "set") against = buildAnnotatedInventory(templateHtml, content, "");
  }
  return { ok: true, content };
}
