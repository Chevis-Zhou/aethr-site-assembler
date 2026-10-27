# Site Assembler — Assembler + Self-Edit Backend

Assembler and section library for AethrDesign's productized (Assembled/Directed/Bespoke) sites,
plus the self-edit backend every rung consumes. `aethr-portal` mirrors `src/lib/edit/` in at
build time (see ADR-0004) — this repo is the source of truth for that module, not a peer of it.

## Language

**Partition**:
The free/paid line — which paths a client can edit under the base $500 price versus which
require a change ticket. Derived as data from the Zod prop schemas (`spec-adapter.ts`), never
restated as a second list.
_Avoid_: tier boundary, edit boundary

**Reader**:
One of the two things that turns a site's content into a `FieldInventory`. Reader #1
(`spec-adapter.ts`) reads a `SiteSpec`. Reader #2 (`annotation-adapter.ts`) reads a hand-built
page's `data-ae` markup. Both produce the same shape; the editor UI never knows which one ran.
_Avoid_: parser, extractor

**Carrier**:
Which of the two site shapes (assembled from a `SiteSpec`, or hand-built and annotated) a piece
of code is written against. Code above the reader/writer seam is carrier-neutral by design.
_Avoid_: mode, variant

**Inventory / FieldInventory**:
Everything the editor UI knows about a site's editable content — id, type, constraints, current
value — for one page or the whole site. The UI never sees a `SiteSpec` and never imports Zod.
_Avoid_: schema, manifest (manifest is reserved for the annotation manifest specifically)

**Field id**:
A dot-path (`a.b.0.c`) naming one editable value. The vocabulary of an id is reader-specific
(`pages[0].sections[3].props.title` for reader #1, `hero.title` for reader #2) but the shape
`FieldInventory` presents is identical.

**Change ticket**:
A locked (paid) edit a client cannot make themselves — offered as a priced upsell (`minor` /
`major`, see `CHANGE_PRICE_CENTS`) rather than refused outright.
_Avoid_: upsell, paid edit (paid edit is fine in prose, but the code and the client copy say
"change ticket")

**The floor**:
The minimum-items guard on an editable list (`list.min`). An `EditOp` that would remove the last
item, or drop below the declared minimum, fails with reason `"floor"` rather than producing a
headed-but-empty section.

**Alt sibling**:
The field id that supplies an image's alt text (e.g. `founderImage` → `founderName`). Enforced on
write in two places by design — see ADR-0001-adjacent finding on `ALT_SIBLING` duplication (not
yet an ADR; recorded as a flagged finding, not a decision).

**Minor / major**:
The two change-ticket classes and their fixed prices (`CHANGE_PRICE_CENTS.minor` /
`.major`). Minor = an unreachable detail inside an editable section. Major = a region with no
editable content in it at all (nav, layout wrapper, footer bar).

**Markers**:
The `data-ae-*` attributes the assembled carrier's section components emit, preview-only, so the
portal's canvas can address assembled sites the same way it addresses hand-built ones. See
ADR-0002.

**Preview**:
The React components (`preview.tsx`) that render a `SiteSpec` for the live-editing canvas. Not
exported from the module barrel — see ADR-0002.
