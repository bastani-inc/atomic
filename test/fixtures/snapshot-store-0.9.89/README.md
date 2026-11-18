# Snapshot blob store 0.9.89 (vendored, unmodified)

The worktree-snapshot blob store and reference index of Atomic 0.9.89, a release that indexes the pins of partly
restored worktrees (#4922) but keeps no progress row of its own backfill (#5558). Its session reference index is the
same as 0.9.88's. `test/unit/snapshot-index-older-build-interleavings.test.ts` runs it, with the 0.9.87 store next to
this directory, against stores this version wrote: its collection must not delete a bundle a pin keeps after 0.9.87
indexed sessions its way, and upgrading a store it indexed must not index it again.

Provenance: tag `0.9.89`, commit `3656a9f50f214387828190309fe87e7b77ec1230`, directory `packages/coding-agent/src/core`.
The files are the module closure of `worktree-snapshot/blob-store.ts` at that commit (type-only imports are erased),
byte for byte:

```sh
git archive 0.9.89 packages/coding-agent/src/core/worktree-snapshot/blob-store.ts \
  packages/coding-agent/src/core/storage/dialect.ts packages/coding-agent/src/core/storage/errors.ts \
  packages/coding-agent/src/core/storage/migrations.ts packages/coding-agent/src/core/storage/prefix.ts \
  packages/coding-agent/src/core/storage/run-journal.ts packages/coding-agent/src/core/storage/write-ahead-log.ts \
  | tar -x --strip-components=4
```

The store loads `storage/journal-adoption.ts` and `worktree-snapshot/errors.ts` only when it writes or moves a chunked
blob or refuses a snapshot whose blobs are gone; the tests never make it do either, so those modules are not vendored.

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the test loads it by path so it is not type-checked against this version.
