/**
 * The self-edit backend, ticket 012. One backend for every rung: the portal consumes this
 * module and never reaches past it into `assembly/` — so the second reader (the annotation
 * manifest, for hand-built sites) lands here without the editor UI changing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Every export is named, and the list below IS the interface.
 *
 * It was three `export *` lines until 2026-09-21, which made the interface whatever the
 * files happened to mark `export` — 23 symbols, five of which no caller had ever imported,
 * and no way to tell the two apart. A named list costs one line per addition and makes
 * widening the partition a decision someone has to write down.
 *
 * Adding a symbol here is adding to the contract the portal builds against, across a repo
 * boundary, through `sync-template.mjs`. Internals stay internal: `html-scan.ts` is not
 * exported at all, and `parsePath`'s `PathToken`, `spec-adapter`'s `RICHTEXT_LEAVES` and
 * `inventoryFromJson` are reachable inside this folder and nowhere else.
 *
 * TWO FILES ARE DELIBERATELY NOT RE-EXPORTED, both for the same reason — they render:
 *
 *   • `preview.tsx` pulls in fourteen React components behind a `"use client"` boundary, so
 *     a server route importing the partition would drag the whole section tree into a
 *     server bundle.
 *   • `markers.tsx` is imported by those same section components. Routing it through here
 *     would make every built site import the edit backend — Zod, both readers, the write
 *     path — to emit a handful of `data-ae-*` attributes that no visitor ever sees.
 *
 * Import those two directly where they are rendered. The lint rule that forbids every other
 * deep import (`no-restricted-imports`, in `eslint.config.mjs`) carves out exactly these.
 *
 * The `scripts/check-*` conformance tools are also exempt: they verify this module's own
 * invariants and are its internal test seam, not callers.
 * ──────────────────────────────────────────────────────────────────────────── */

/* The field-inventory contract — what every reader produces and the UI consumes. */
export {
  CHANGE_PRICE_CENTS,
  formatPath,
  getAtPath,
  parsePath,
  setAtPath,
} from "./inventory";
export type {
  FieldInventory,
  InventoryField,
  InventoryGroup,
  InventoryList,
  InventoryPage,
  LockedControl,
} from "./inventory";

/* Reader #1 — the `SiteSpec` partition, and the same rule as a server-side predicate. */
export { buildInventory, isFreePath } from "./spec-adapter";

/* The write path. */
export { applyEdit, applyEdits } from "./apply";
export type { ApplyFailure, ApplyResult, EditOp } from "./apply";

/* Reader #2 — the annotation manifest, for hand-built sites. */
export { buildAnnotatedInventory } from "./annotation-adapter";
export { TemplateError, render } from "./annotation-template";
/* Preview dispatch consumes this same shared descriptor that validates writes. */
export { parseBundle, pageTemplate } from "./shared/bundle.mjs";
export { applyAnnotatedEdits } from "./annotation-apply";
