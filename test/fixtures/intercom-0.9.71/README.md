# Intercom 0.9.71 (vendored, unmodified)

The Intercom broker and client of Atomic 0.9.71, the release before the Intercom wire protocol range (#4538). The
contract and upgrade tests run them against this version's broker and sessions:

- `test/integration/intercom-previous-release-contract.test.ts`: the 0.9.71 client against this version's broker.
- `test/integration/intercom-broker-upgrade.test.ts`: a 0.9.71 broker and session running when a session of this
  version starts, replaces the broker and keeps exchanging messages with the 0.9.71 session.

Provenance: tag `0.9.71`, commit `e32a426e8d26795d06a9fc999c6de8edcf55432c`, directory `packages/intercom`. The files
are the module closure of `broker/broker.ts`, `broker/client.ts` and `broker/spawn.ts` at that commit, byte for byte:

```sh
git archive 0.9.71 <closure> | tar -x
```

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the tests load it by path so it is not type-checked against this version.
