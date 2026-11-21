Atomic's first-party packages as 0.10.3 published them:

- `package-exports.json`: each package's `exports` map, by key, with the file its `import` (else `default`) condition
  names; `null` for a package without one.
- `package-files.json`: the JavaScript files a bare specifier can reach through a pattern export (`./utils/*`), or
  anywhere in a package without an exports map, by path in the package.

Node and Bun read a package's `package.json` once per process, and Bun also reads each directory's entries once, so a
0.10.3 process still running when Atomic is updated in place resolves the updated files' imports through these maps and
these directory listings. Regenerate from an install of `@bastani/atomic@0.10.3`.
