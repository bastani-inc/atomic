# Intercom restoring-reservation store before #5067 (vendored, unmodified)

The PostgreSQL-capable `RestoringReservationStore` as `main` shipped it before #5067, which named the wake index
`<prefix>intercom_restoring_reservations_wake_requested`. PostgreSQL cuts that name short at 63 bytes under a prefix
longer than 17 characters. `test/integration/storage-postgres-prefix-length.test.ts` creates a store with it and checks
that this version renames the index and keeps the store working.

Provenance: commit `8cd7613f0c94c9c25d89cd11ca53d3cb2593ffd6`, directory `packages/intercom/broker`. The files are the runtime module
closure of `sql-restoring-reservation-store.ts` at that commit, byte for byte (its other imports are types only):

```sh
git archive 8cd7613f0c94c9c25d89cd11ca53d3cb2593ffd6 packages/intercom/broker/{sql-restoring-reservation-store,released-children,sql-add-column}.ts
```

Do not edit them. Biome ignores `test/fixtures/**`, and the test loads them by path.
