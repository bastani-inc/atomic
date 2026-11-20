# Intercom client of main before #5999 (vendored, unmodified)

The Intercom client of `main` just before #5999 (resuming finished subagents by message) merged.
`test/integration/intercom-ended-child-wake.test.ts` runs it against this version's broker: a client that never asks to
wake an ended recipient must get exactly the answers it got before, for example `delivered`, not `queued`, for a message
a live subagent whose user paused its turn saved.

Provenance: commit `edfa0f71b1` (`main`), directory `packages/intercom`. The files are the module closure of
`broker/client.ts` at that commit, byte for byte:

```sh
git archive edfa0f71b1 <closure> | tar -x
```

Do not edit them; replace the directory when the previous release changes. Biome ignores `test/fixtures/**`, the root
`tsconfig.json` excludes this directory, and the tests load it by path so it is not type-checked against this version.
