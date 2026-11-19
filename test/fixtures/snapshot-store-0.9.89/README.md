# Snapshot blob store 0.9.89 (vendored, unmodified)

The worktree-snapshot blob store and reference index of Atomic 0.9.89, the last release whose chunk table,
`snapshot_blob_chunks`, is a `WITHOUT ROWID` table (#5541). `test/unit/snapshot-chunk-layout-move.test.ts` creates
stores with it, as that release left them, and runs it beside this version on one database: while collection moves the
chunk table to the row layout and after, a 0.9.89 process must keep reading, writing and collecting every blob.

Provenance: tag `0.9.89`, commit `3656a9f50f214387828190309fe87e7b77ec1230`, directory `packages/coding-agent/src/core`.
The files are the module closure of `worktree-snapshot/blob-store.ts` at that commit (type-only imports are erased),
byte for byte:

```sh
git archive 0.9.89 packages/coding-agent/src/core/worktree-snapshot/blob-store.ts \
  packages/coding-agent/src/core/storage/{dialect,errors,migrations,prefix,run-journal,write-ahead-log}.ts \
  | tar -x --strip-components=4
```

`storage/journal-adoption.ts` is not vendored: the blob store imports it only when it writes a chunked blob, to upgrade a
run journal at schema version 1, and that module needs most of 0.9.89's storage layer. It re-exports this version's
`upgradeRunJournalSchema`, which upgrades a journal the same way.

Do not edit the vendored files; replace the directory when the previous release changes. Biome ignores
`test/fixtures/**`, the root `tsconfig.json` excludes this directory, and the test loads it by path so it is not
type-checked against this version.
