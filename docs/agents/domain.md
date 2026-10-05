# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**This repo is single-context.** There is no `CONTEXT-MAP.md` and no `src/<context>/docs/adr/`.
Everything lives at the root: one `CONTEXT.md` and one `docs/adr/`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in

Neither exists yet. If they don't exist, **proceed silently**. Don't flag their absence; don't
suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/             ← currently empty; filenames are NNNN-short-slug.md
│   └── agents/          ← this file and its siblings
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Existing narrative docs

`README.md` already carries the domain knowledge in prose form — the classification priority
table, the dedupe safety boundaries, the three hard constraints, and a table of root-caused
bugs. Read it before proposing changes to `src/`. Once a decision is settled and worth
locking in, move it out of README and into an ADR so the reasoning survives refactors.
