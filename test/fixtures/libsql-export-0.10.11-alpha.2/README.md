# A libSQL store exported by Atomic 0.10.11-alpha.2

`sessions/` is what `atomic storage export` of Atomic 0.10.11-alpha.2 wrote from a libSQL `file:` database, the first
step of moving sessions off libSQL after 0.10.11 removed it. `seed.mjs` wrote the store with that release's SDK and
`@bastani/atomic-storage-libsql@0.10.11-alpha.2`:

- a session with a worktree snapshot (its two blobs carried inline) and a tool result,
- a fork of that session's leaf and a fork from its first entry, which shared the parent's history in the store
  (`parentSessionId` in their headers, the whole history in their files),
- an unrelated session.

Regenerate:

```bash
npm install @bastani/atomic@0.10.11-alpha.2 @bastani/atomic-storage-libsql@0.10.11-alpha.2
node seed.mjs file:/tmp/store.db /tmp/repo
echo '{"adapter":"@bastani/atomic-storage-libsql","options":{"url":"file:/tmp/store.db"}}' > store.json
npx atomic storage export out --storage-file store.json
```

Run the export with an agent directory whose `packages` setting lists the installed adapter package.
