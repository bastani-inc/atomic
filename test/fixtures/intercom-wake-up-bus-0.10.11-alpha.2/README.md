# Intercom wake-up bus of 0.10.11-alpha.2 (vendored, unmodified)

The database wake-up bus as release 0.10.11-alpha.2 shipped it: every broker listens on the one channel named like the
hint table, a notification carries the broker id, and a hint names no recipient.
`test/integration/intercom-postgres-notify-path.test.ts` runs it beside this version's bus on one PostgreSQL database,
as a broker of the earlier release would run during an upgrade, and checks that each wakes the other's brokers.

Provenance: tag `0.10.11-alpha.2`, commit `8a490f9438aecaf1a3dc3a46c96cf239f44dfc92`, directory
`packages/intercom/broker`. The files are the runtime module closure of `database-wake-up-bus.ts` at that commit, byte
for byte (its other imports are types only):

```sh
git archive 0.10.11-alpha.2 packages/intercom/broker/{database-wake-up-bus,multinode-state-store,released-children,sql-schema}.ts
```

Do not edit them. Biome ignores `test/fixtures/**`, the root `tsconfig.json` excludes this directory, and the test
loads it by path so it is not type-checked against this version.
