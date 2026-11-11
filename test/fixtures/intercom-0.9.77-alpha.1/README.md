# Intercom 0.9.77-alpha.1 (vendored, unmodified)

The Intercom client of Atomic 0.9.77-alpha.1, the last release before released workflow stages were hosted on one
broker connection (#4642). `test/integration/intercom-previous-release-contract.test.ts` runs it against this version's
broker: a client of that release must keep its connection and get a plain refusal when it sends to a released stage
whose hosted peer is gone, and must be able to list, ask and send to a hosted released stage.

Provenance: tag `0.9.77-alpha.1`, commit `f3174e39fbe4a69bcac996346150f46e2d0386f4`, directory `packages/intercom`. The files are the module closure of
`broker/client.ts` at that commit, byte for byte:

```sh
git archive 0.9.77-alpha.1 <closure> | tar -x
```

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the tests load it by path so it is not type-checked against this version.
