# Intercom broker state before #5218 (vendored, unmodified)

The PostgreSQL-capable Intercom broker state as `main` shipped it before #5218: each store's open runs
`CREATE … IF NOT EXISTS` in the database's default schema, `public`, and reads no version.
`test/integration/storage-postgres-roles.test.ts` opens it after `atomic storage migrate` moved the tables to schema
`atomic`, as a broker of the earlier release would, and checks that it is refused at its first write and creates nothing.

Provenance: commit `482621a96a2b3c4efe5a351729acbf10645c12c3`, directory `packages/intercom/broker`. The files are the
runtime module closure of `open-broker-state.ts` at that commit, byte for byte (its other imports are types only):

```sh
git archive 482621a96a2b3c4efe5a351729acbf10645c12c3 packages/intercom/broker/{open-broker-state,database-wake-up-bus,multinode-state-store,released-children,sql-add-column,sql-held-send-store,sql-known-session-store,sql-lease-store,sql-outbox-store,sql-pending-ask-store,sql-released-ask-store,sql-restoring-reservation-store,sql-sent-message-authority}.ts
```

Do not edit them. Biome ignores `test/fixtures/**`, and the test loads them by path.
