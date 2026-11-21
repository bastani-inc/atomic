# Atomic 0.10.3 module exports (recorded, unmodified)

The export names of modules of the published `@bastani/atomic@0.10.3` package that a process running that release has
loaded when an update replaces its installation. Such a process keeps the copies it loaded and loads every later module
from the update, so a later module can name only exports these copies have. `test/unit/in-place-update-imports.test.ts`
checks this build against them.

- `entry`: every module of `dist/cli.js`'s static graph inside `dist/` (loaded when the process starts).
- `modules`: modules of the session's graph that a module loaded on demand imports from.
- `host`: the host modules the builtin extensions import through `@bastani/atomic` and `@bastani/atomic/storage`.

Provenance: `npm install -g @bastani/atomic@0.10.3`, then for each module the keys of its namespace
(`Object.keys(await import(module))`, which includes `export *`), sorted. The `@bastani/atomic-ai` and
`@bastani/atomic-tui` entries are those packages at 0.10.3 as the installed package resolves them.

Do not edit the lists: a name added to one of these modules after 0.10.3 is read through a namespace import that
tolerates its absence, never named in an `import { … }`.
