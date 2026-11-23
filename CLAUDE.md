# aethr-site-assembler

Assembler and section library for Aethr Design's productized sites, plus the self-edit backend (`src/lib/edit/`) that `aethr-portal` mirrors at build time. Next.js, deployed per client through the shared publish workflow. Vocabulary: [CONTEXT.md](CONTEXT.md).

Generic engineering rules live in `~/Developer/Standards/coding-standard.md`; this file holds only what is specific to this repo.

## Map

| Path | What lives there |
|---|---|
| `src/app/`, `src/components/` | Routes and the section components |
| `src/lib/edit/` | Self-edit backend: readers, write path, inventory. Public entry `index.ts` (ADR-0004) |
| `src/lib/assembly/` | Spec to site assembly (see `SPEC-FORMAT.md` there) |
| `src/lib/change/`, `deploy/`, `qa/`, `theme/`, `instrumentation/` | Change tickets, deploy, QA gates, theming, instrumentation |
| `src/lib/analysis/` | Private nested repo (`aethr-analysis`), gitignored. Absent in public checkouts; nothing tracked imports it |
| `scripts/` | `sync-edit-layer.mjs`, `check-*` conformance tools, `publish-client.ts` |
| `.github/workflows/client-publish.yml` | Shared cloud builder; builds and uploads an artifact only, holds no Cloudflare credential |
| `docs/adr/` | Architecture decision records |
| `CONTEXT.md` | Domain glossary (Partition, Reader, Carrier, Change ticket, Markers, ...) |

This repo is public: no client contact details, account or zone IDs, or anything from the analysis layer.

### Agent skills

#### Issue tracker

Local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

#### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commands

| Task | Command |
|---|---|
| Dev server | `pnpm dev` (syncs edit layer, then `next dev`, port 3000) |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Test | `pnpm test` (`node:test` via `tsx`) |
| Build | `pnpm build` |
| Deploy | TODO(owner): publish runs via `client-publish.yml`, portal's deploy coordinator makes it live |

`dev`, `build`, `test` and `typecheck` first run `scripts/sync-edit-layer.mjs`, which reads the sibling `../aethr-edit-layer` checkout and writes gitignored output under `src/lib/edit/shared/`.

## Seams / contracts

```seams
module edit src/lib/edit/index.ts
contract src/lib/edit/index.ts
```

`src/lib/edit/index.ts` is a named-export barrel and a published contract: `aethr-portal` builds against its exports, so adding one is a commitment (ADR-0004). Everything else under `src/lib/edit/` is imported through it, enforced by `no-restricted-imports` in `eslint.config.mjs`. Direct imports are allowed only for `markers` and `preview` (ADR-0002) and for `scripts/check-*` (ADR-0006).

## Settled

- 2026-09-21: No Effect for boundary enforcement; ESLint `no-restricted-imports`, `dependency-cruiser` later if needed. [ADR-0001](docs/adr/0001-no-effect-for-boundary-enforcement.md)
- `markers` and `preview` stay outside the edit barrel (bundle size, not an oversight). [ADR-0002](docs/adr/0002-markers-and-preview-outside-the-barrel.md)
- Tests use `node:test` + `tsx`; no vitest or Jest. [ADR-0003](docs/adr/0003-node-test-not-vitest.md)
- `src/lib/edit/` here is the SSOT; the portal's `src/template/` is a gitignored mirror, never hand-edited there. [ADR-0004](docs/adr/0004-edit-backend-is-a-cross-repo-contract.md)
- `markers` is a prop, not a React context. [ADR-0005](docs/adr/0005-markers-is-a-prop-not-a-context.md)
- `scripts/check-*` stay outside the `no-restricted-imports` rule's `files` glob. [ADR-0006](docs/adr/0006-check-scripts-exempt-from-no-restricted-imports.md)
