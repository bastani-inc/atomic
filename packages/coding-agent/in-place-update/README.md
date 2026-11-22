# Released versions, as a running process of each holds them

A process keeps every module it has loaded and loads the rest from the installation on disk, which an in-place update
(`npm install -g`, `bun add -g`) replaces while the process runs. Each `<version>.json` here records what such a process
of a published release holds and loads: for `@bastani/atomic` and the packages of its own it depends on, each package's
exports map, the export names of each JavaScript file, the files its code imports on demand or starts as a worker, the
files the CLI has loaded before it loads anything on demand (`startup`), and the files every running process has loaded
(`running`). `scripts/in-place-update-exports.mjs` writes and reads them. This directory is not published.

What reads them:

- The build's split (`scripts/split-dist.mjs`) keeps every file a recorded release imports on demand at its path, and
  fails when no module of the package compiles to one any more.
- The split also makes each such file that the package neither imports statically nor loads as it starts a gate
  (`scripts/in-place-update-gate.mjs`): it imports the module's code from the file beside it, and only when that fails
  asks which release the process runs, through a module every process of each recorded release loaded (`running`),
  and tells a process of an earlier release to restart. Where this build writes no file at such a module's path, it
  writes an empty stub there, so that Node still resolves the path and gives that process the module it holds.
- `test/unit/in-place-update-releases.test.ts` checks the built packages against every record, in both directions: a
  file such a process loads after the update names only exports of the earlier copies it may hold, through the exports
  maps it read, and what the earlier release loads on demand is still there with the exports it had.
- `scripts/in-place-update-e2e.mjs` installs each recorded release from npm, starts a process of it, updates it in place
  to the packed build and imports every file the release imports on demand: each loads or says to restart, and the
  modules a session loads for its own work load, unless `allowed.json` lists the subpath they fail on for that
  release. `test/integration/in-place-update-e2e.test.ts` runs it on the build.
- The release workflow runs both on the packed release, and fails when the latest version published before it is not
  recorded.

`allowed.json` lists, by release, the package subpaths this build may import although that release's exports map
lacks them, each with why no process of that release meets them. The test fails once nothing imports one any more.

Record a release once it is published:

```sh
node scripts/in-place-update-exports.mjs record --published 0.10.4 > packages/coding-agent/in-place-update/0.10.4.json
```

It downloads the release's packages from npm. `record <package-dir>...` records installed or unpacked packages instead,
`@bastani/atomic` first.
