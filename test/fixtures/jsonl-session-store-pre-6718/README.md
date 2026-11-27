The JSONL session store before #6718 (directory-only `proper-lockfile` locking on `<dir>/.session.lock`),
captured from commit `0703179e93` with relative imports retargeted to `packages/coding-agent/src/`.

`test/unit/jsonl-session-store-advisory-locks.test.ts` runs this older store concurrently beside the current
`JsonlSessionStore` to verify mixed-version mutual exclusion, group handoff, and ABA safety.
