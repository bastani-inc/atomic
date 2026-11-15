# Snapshot blob store 0.9.87 (vendored, unmodified)

The worktree-snapshot blob store and reference index of Atomic 0.9.87, the release before chunked snapshot blobs
(#4954) and the pins of partly restored worktrees (#4922). `test/unit/snapshot-store-older-build.test.ts` runs it
against stores this version wrote (#5065): it must never read a chunked blob as empty, and its collection must not
leave this version trusting reference triggers it reinstalled.

Provenance: tag `0.9.87`, commit `1718dfa4688076645816297213b64c7351f940b3`, directory `packages/coding-agent/src/core`.
The files are the module closure of `worktree-snapshot/blob-store.ts` at that commit (type-only imports are erased),
byte for byte:

```sh
git archive 0.9.87 packages/coding-agent/src/core/worktree-snapshot/blob-store.ts \
  packages/coding-agent/src/core/storage/errors.ts packages/coding-agent/src/core/storage/prefix.ts \
  packages/coding-agent/src/core/storage/write-ahead-log.ts | tar -x --strip-components=4
```

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the test loads it by path so it is not type-checked against this version.
