# Snapshot blob store 0.9.89 (vendored, unmodified)

The worktree-snapshot blob store and reference index of Atomic 0.9.89. Two suites run it beside this version on one
database:

- It is the last release whose chunk table, `snapshot_blob_chunks`, is a `WITHOUT ROWID` table (#5541).
  `test/unit/snapshot-chunk-layout-move.test.ts` creates stores with it, as that release left them: while collection
  moves the chunk table to the row layout and after, a 0.9.89 process must keep reading, writing and collecting every
  blob.
- It indexes the pins of partly restored worktrees (#4922) but keeps no progress row of its own backfill (#5558). Its
  session reference index is the same as 0.9.88's. `test/unit/snapshot-index-older-build-interleavings.test.ts` runs
  it, with the 0.9.87 store next to this directory, against stores this version wrote: its collection must not delete
  a bundle a pin keeps after 0.9.87 indexed sessions its way, and upgrading a store it indexed must not index it again.

Provenance: tag `0.9.89`, commit `3656a9f50f214387828190309fe87e7b77ec1230`, directory `packages/coding-agent/src/core`.
The files are the module closure of `worktree-snapshot/blob-store.ts` at that commit (type-only imports are erased),
byte for byte:

```sh
git archive 0.9.89 packages/coding-agent/src/core/worktree-snapshot/blob-store.ts \
  packages/coding-agent/src/core/storage/{dialect,errors,migrations,prefix,run-journal,write-ahead-log}.ts \
  | tar -x --strip-components=4
```

`storage/journal-adoption.ts` is not vendored whole: the blob store imports it only when it writes a chunked blob, to
upgrade a run journal at schema version 1, and that module needs most of 0.9.89's storage layer. It holds only that
release's `upgradeRunJournalSchema` and the table definitions it applies, copied byte for byte; this version keeps no run
journal of its own to borrow them from. `worktree-snapshot/errors.ts`, which the store loads
only to refuse a snapshot whose blobs are gone, is not vendored either; no test makes it do that.

Do not edit the vendored files; replace the directory when the previous release changes. Biome ignores
`test/fixtures/**`, the root `tsconfig.json` excludes this directory, and the test loads it by path so it is not
type-checked against this version.
