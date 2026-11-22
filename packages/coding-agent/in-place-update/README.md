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
- `test/unit/in-place-update-releases.test.ts` checks the built packages against every record, in both directions: a
  file such a process loads after the update names only exports of the earlier copies it may hold, through the exports
  maps it read, and what the earlier release loads on demand is still there with the exports it had.
- The release workflow runs the same check on the packed release, against every record and the latest version
  published before it.

`allowed.json` lists, by release, the package subpaths this build may import although that release's exports map
lacks them, each with why no process of that release meets them. The test fails once nothing imports one any more.

Record a release once it is published:

```sh
node scripts/in-place-update-exports.mjs record --published 0.10.4 > packages/coding-agent/in-place-update/0.10.4.json
```

It downloads the release's packages from npm. `record <package-dir>...` records installed or unpacked packages instead,
`@bastani/atomic` first.
