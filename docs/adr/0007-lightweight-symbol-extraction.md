# ADR-0007: Scan-based export/import extraction in the Worker; tsc in the Sandbox is the source of truth

- Status: Accepted
- Date: 2026-10-10

## Context
The in-flight index needs "which exported symbols did this fork change, and how" (added, removed,
signature changed, body changed), plus "which symbols does each touched file import". Running the TypeScript
compiler in a Worker means a multi-MB bundle and heavy CPU per push.

## Decision
`worker/src/symbols.ts` uses a small bracket-aware scanner over top-level `export` declarations
(functions, consts, classes, interfaces, types, enums) and named `import`s, with relative-path resolution.
Signatures are whitespace-normalized, and comments are stripped before comparing.
Diff size uses a multiset line difference, which is enough to rank "cheaper to rebase".
Unit tests live in `worker/test/symbols.test.ts`.

## Consequences
- Early signals (overlaps, signature changes) are heuristic and labelled informational.
- Semantic-conflict verdicts come only from a real `tsc --noEmit` on the speculative merge (milestone 4).
