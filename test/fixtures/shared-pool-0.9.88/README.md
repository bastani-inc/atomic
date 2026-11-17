# Shared pool stores 0.9.88 (vendored, unmodified)

The shared placement store (`SqlSharedPool`), the fleet controller's store and the fleet rate buckets of Atomic 0.9.88,
the release before the host registry's shipping, progress and report-time columns and the rate buckets' token count
(#4768). `test/helpers/pool-store-conformance.ts` runs them beside this version's stores on one database, in both orders:
a 0.9.88 host must keep opening, reporting to and reading a store this version upgraded, and this version must upgrade
a store a 0.9.88 host keeps using.

Provenance: tag `0.9.88`, commit `f3c0a544a350a2e5fe9790f460346385678999f6`, directory `packages/workflows/src`. The files
are the module closure of `durable/journal/sql-shared-pool.ts` and `durable/journal/sql-rate-buckets.ts` at that commit
(type-only imports are erased), byte for byte:

```sh
git archive 0.9.88 packages/workflows/src/durable/journal/{internal,pool-guarded-write,pool-schema-probe,shared-store-health,sql-fleet,sql-rate-buckets,sql-shared-pool,stage-input-kinds,types,values}.ts \
  packages/workflows/src/workers/{placement-errors,stage-input-kind}.ts | tar -x --strip-components=3
```

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the conformance suite loads it by path so it is not type-checked against
this version.
