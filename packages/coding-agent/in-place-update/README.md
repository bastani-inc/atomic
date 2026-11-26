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
- Since 0.10.5 each of this build's own imports of a module on demand is guarded at its call site
  (`scripts/in-place-update-gate.mjs`, `callSiteGuardSource`): when the import fails and the process runs an earlier
  release than the file that imports, or the installation on disk is no longer that file's release, it fails with the
  restart message and the failure as its cause. So a process of 0.10.5 or later tells itself to restart whatever a later
  release puts at those paths, and its record needs no gates.
- For the releases before (0.10.3, the 0.10.4 prereleases, 0.10.4), whose own code does no such thing, the split makes
  each file such a release imports on demand, that the package neither imports statically nor loads as it starts, a
  gate: it imports the module's code from `<module>.code.js` beside it, and only when that fails asks which release the
  process runs, through a module every process of each recorded release loaded (`running`), and tells a process of an
  earlier release to restart. 0.10.4 imported such a module's code at `<module>.impl.js`; that path is a gate as well.
  Where this build writes no file at a release's module path, it writes an empty stub there, so that Node still resolves
  the path and gives that process the module it holds. This build's own files import a module's code at
  `<module>.code.js` (a path no earlier release imports, which later releases keep), so only a process of an earlier
  release meets a gate, and a bundle of the package (the standalone binary's, in CommonJS) never holds a gate's
  top-level `await`.
- `test/unit/in-place-update-releases.test.ts` checks the built packages against every record, in both directions: a
  file such a process loads after the update names only exports of the earlier copies it may hold, through the exports
  maps it read, and what the earlier release loads on demand is still there with the exports it had.
- `scripts/in-place-update-e2e.mjs` installs each recorded release from npm, starts a process of it, updates it in place
  to the packed build and imports every file the release imports on demand: each loads or says to restart, and the
  modules a session loads for its own work load, unless `allowed.json` lists the subpath they fail on for that
  release. It also updates a running process of the build itself to a later release whose code for some of the modules
  it loads on demand cannot load there: its own call sites say to restart. `test/integration/in-place-update-e2e.test.ts`
  runs it on the build.
- The release workflow runs both on the packed release. The export check also covers the newest release published
  before it and the newest stable one. For releases before 0.10.5 (`GUARDED_SINCE`), it fails when either is not
  recorded here (those releases need build-time gates); from 0.10.5 onward, an unrecorded one is downloaded from npm
  and checked automatically without needing a committed JSON snapshot first.

`allowed.json` lists, by release, the package subpaths this build may import although that release's exports map
lacks them, each with why no process of that release meets them. The test fails once nothing imports one any more.

Record a release once it is published:

```sh
node scripts/in-place-update-exports.mjs record --published 0.10.4 > packages/coding-agent/in-place-update/0.10.4.json
```

It downloads the release's packages from npm. `record <package-dir>...` records installed or unpacked packages instead,
`@bastani/atomic` first.
