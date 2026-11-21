# Atomic 0.10.3 (recorded, unmodified)

What a process running the published `@bastani/atomic@0.10.3` package has loaded or read when an update replaces its
installation. Such a process keeps the modules it loaded, the `package.json` files it read (Node and Bun) and the
directory entries it read (Bun), and loads every later module from the update, so the updated files' imports must
resolve and link against these. Regenerate from an install of `@bastani/atomic@0.10.3`.

- `exports.json`, checked by `test/unit/in-place-update-imports.test.ts`: the export names of modules such a process has
  loaded, so a later module can name only exports these copies have.
  - `entry`: every module of `dist/cli.js`'s static graph inside `dist/` (loaded when the process starts).
  - `modules`: modules of the session's graph that a module loaded on demand imports from.
  - `host`: the host modules the builtin extensions import through `@bastani/atomic` and `@bastani/atomic/storage`.

  For each module, the keys of its namespace (`Object.keys(await import(module))`, which includes `export *`), sorted.
  The `@bastani/atomic-ai` and `@bastani/atomic-tui` entries are those packages at 0.10.3 as the installed package
  resolves them. A name added to one of these modules after 0.10.3 is read through a namespace import that tolerates
  its absence, never named in an `import { … }`.
- `package-exports.json`: each first-party package's `exports` map, by key, with the file its `import` (else `default`)
  condition names; `null` for a package without one.
- `package-files.json`: the JavaScript files a bare specifier can reach through a pattern export (`./utils/*`), or
  anywhere in a package without an exports map, by path in the package.
