# Intercom terminal-ordering red/green evidence

Base under test: `origin/main` at `0f4496eb5056709bf0dd8dd0b7916bf6829cdd73`.

## Primary ordering regression

The regression `queued child messages drain before a direct terminal notification` uses only modules already present on `origin/main`. The test file was copied into a detached `origin/main` worktree, that worktree was linked to the checkout's installed dependencies, and the focused test was run before the production fix:

```sh
AGENT=1 bun test test/unit/subagents-completion-notification.test.ts \
  --test-name-pattern "queued child messages"
```

### Red — `origin/main`

```text
AssertionError: Expected values to be strictly deep-equal:
actual:   ["subagent-notify", "Ready…"]
expected: ["Ready…", "subagent-notify"]

0 pass
1 filtered out
1 fail
Ran 1 test across 1 file.
```

This behaviorally reproduces issue #1802: the already idle-queued ordinary message remains pending when the direct pause notification is delivered, then appears afterward when the idle queue flushes.

### Green — ordering-barrier branch

The identical command after the production fix:

```text
1 pass
1 filtered out
0 fail
Ran 1 test across 1 file.
```

Captured outputs: `/tmp/atomic-1802-ordering-origin-main-red.txt` and `/tmp/atomic-1802-ordering-green.txt`.

## Exactly-once resend regression

A second focused regression covers stable-message-ID broker resends that have already been surfaced by the foreground handoff:

```sh
AGENT=1 bun test test/unit/intercom-foreground-detach-handoff.test.ts \
  --test-name-pattern "duplicate delivered messages"
```

On `origin/main` behavior the focused assertion fails with `true !== false` because the delivered disposition does not release provisional queue ownership. With delivered-disposition cleanup on this branch it passes (`1 pass`, `0 fail`). Captured outputs: `/tmp/atomic-1802-origin-main-red.txt` and `/tmp/atomic-1802-duplicate-green.txt`.

## Empty-prelude dual-path deduplication

The focused regression `deduplicates successful empty terminal dispatch across event and global paths` emits the same exact terminal payload first through `pi.events` and then through the process-global companion bridge with no queued ordinary prelude:

```sh
AGENT=1 bun test test/unit/intercom-terminal-ordering-barrier.test.ts \
  --test-name-pattern "deduplicates successful empty terminal dispatch"
```

### Red — branch commit `90b71f26a`

```text
AssertionError: Expected values to be strictly equal:
2 !== 1

0 pass
14 filtered out
1 fail
Ran 1 test across 1 file.
```

### Green — corrected barrier

```text
1 pass
14 filtered out
0 fail
Ran 1 test across 1 file.
```

Captured outputs: `/tmp/atomic-pr1810-empty-drain-red.txt` and `/tmp/atomic-pr1810-empty-drain-green.txt`. Companion regressions verify a failed empty terminal dispatch remains retryable and distinct pause/completion terminal identities for one resumed run still dispatch independently.

## Genuine source-runtime race and fix

The initial tmux-isolated source run exposed a second race not covered by the direct queue test: the event-bus terminal barrier was registered by lazy Intercom, while the Subagents companion emitted on a distinct loader bus. Parent session persistence placed pause before accepted message `362747a6-97c2-4ca4-9074-b8489cab0b1b` (lines 49 then 51 under `/tmp/atomic-pr1810-source-proof-20260715T030843Z`).

The durable regressions now cover atomic custom-message batch admission and a second terminal path claiming late-arriving pre-terminal messages. The final source run, launched with exactly `bun packages/coding-agent/src/cli.ts`, persisted ordinary pause marker `08a119a7-ff11-4fd4-9f38-1bc43b6982b6` before paused result/notify and ordinary completion marker `d62c9b49-1c98-41c8-a3f5-f16942728be3` before completed result/notify, each exactly once. Machine-readable assertions and tmux evidence are under `/tmp/atomic-pr1810-source-proof-pass-20260715T033034Z/global-pass/logs/`.
