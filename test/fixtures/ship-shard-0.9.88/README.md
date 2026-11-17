# Checkpoint journal compatibility fixture

`ship-shard.ts` is `packages/workflows/src/workers/ship-shard.ts` from tag `0.9.88`. Only its two relative imports point to this checkout's types and errors. Keep the implementation unchanged so rollback tests exercise the released reader.
