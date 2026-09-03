# Intercom recoverable-disconnect red/green evidence

Base under test: `origin/main` at `c20dbb41923b8c60bbcb706d12b88882fc130536`.

Observed during Goal run `16a9f7ed-e55a-44b4-b89f-3b63ef9197a2`: a transient Intercom
broker disconnect surfaced in the workflow-stage UI while the stage kept running and
lazy re-initialization kept recovering.

## The two boundaries that reached the UI

1. **Host extension-error boundary.** `packages/intercom/index.ts` eagerly awaited
   `loadHeavy(ctx)` inside its `session_start` handler for a stage carrying a
   `pendingStageDelivery`. The rejection escaped the handler, so the host's
   `runGenericHandlers` caught it and pushed it through `ExtensionRunner.emitError`
   to `showExtensionError` (interactive) and `console.error("Extension error …")`
   (print).
2. **Lazy event-relay boundary.** The `subagent:*` and pending-stage relays logged
   `Intercom event relay failed (<event>): Client disconnected` straight into the
   stage output for work the user never initiated.

`d3910c0818` silenced only Intercom's own `Intercom heavy initialization failed …`
log, which is neither channel, so the message kept reaching the UI.

## Negative control

The typed classification module (`packages/intercom/recoverable-disconnect.ts`) and
the broker client change were kept in place; only the two behavioral guards were
reverted to their `origin/main` form:

- `reportRelayFailure` restored to an unconditional `console.error`.
- The `session_start` warm-up restored to a bare `await loadHeavy(ctx);`.

```sh
npx vitest --run --project unit test/unit/intercom-recoverable-disconnect-ui.test.ts
```

### Red — guards reverted

```text
 Test Files  1 failed (1)
      Tests  5 failed | 5 passed (10)
```

The host boundary received exactly the record that `showExtensionError` renders:

```text
+   {
+     error: 'Client disconnected',
+     event: 'session_start',
+     extensionPath: '<intercom>',
+     stack: 'IntercomClientDisconnectedError: Client disconnected\n …'
+   }
```

and the relay boundary logged:

```text
+     'Intercom event relay failed (subagent:result-intercom):',
```

The five failures are the four suppression/recovery expectations plus the healthy
lifecycle check. The five that still passed are the actionability controls — a
non-recoverable import failure, a same-worded plain `Error`, a terminal relay
failure, a terminal pending-stage relay failure, and a user-initiated tool call —
confirming the red run fails only for the intended reason.

### Green — with the guards

```text
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Run three consecutive times together with `test/unit/intercom-heavy-init-diagnostics.test.ts`
(15 tests) with no flake.

Captured red output: `/tmp/red-before.txt`.

## Live-broker check

The unit tests stub heavy initialization, so the typed classification was also
checked against a real broker process in a tmux pane. A disposable
`ATOMIC_CODING_AGENT_DIR` gives the probe its own socket and its own broker, so
the machine's live broker is never touched:

```text
isolated agent dir: /var/folders/.../intercom-e2e-dAS0m6/agent
connected to isolated broker: true
connected after killing that broker: false
observed error class:                    IntercomClientDisconnectedError
observed error message:                  Client disconnected
instanceof IntercomClientDisconnectedError: true
isRecoverableIntercomDisconnect:         true
same error wrapped as a cause:           true
plain look-alike stays actionable:       true
```

The probe issues a `send`, kills the broker while that request is in flight, and
inspects the rejection. That in-flight window is the production shape: the client
fails pending requests from `onClose`. A *fresh* call made after the socket has
already closed observes `Not connected` instead, which is deliberately left
actionable.

## Review round 1 — the observed channel, and the missing retry owner

Review found that the two boundaries above are real but were **not** the channel
that leaked in run `16a9f7ed-e55a-44b4-b89f-3b63ef9197a2`. In that stage
transcript the only `Client disconnected` occurrences are `subagent` **tool
results** at steps 32/36/38/40 — the tool returned the bare string as its whole
result four times while the stage kept running. `grep -c "Extension error"` on
that transcript is 0.

The observed path is the advisory supervisor-authorization request:
`broker/client.ts` `failPending` rejects it, `packages/intercom/index.ts` set
`request.completion` with no classification and no catch,
`packages/subagents/src/intercom/supervisor-authorization.ts` rethrows every
non-stale error, and `subagent-executor-single.ts:192` awaits it inside the run
`try`. Review also found that swallowing the warm-up failure left no retry
owner, so a stage holding queued pending messages parks on
`pendingStageDelivery.ready()` — which `stage-runner-controller.ts:1218` awaits
with no timeout — with no signal at all.

Both are covered by tests driving the real production entry points:
`requestSupervisorAuthorization` itself, and a `pendingStageDelivery` modeled on
the real `ready`/`deliverPending` contract.

### Red — the two new guards reverted

Only `.catch` on the authorization completion and the `scheduleWarmUpRetry` call
were removed; everything else was left in place.

```sh
npx vitest --run --project unit test/unit/intercom-recoverable-disconnect-ui.test.ts
```

```text
 Test Files  1 failed (1)
      Tests  3 failed | 14 passed (17)
```

Each failure is the finding itself, not a proxy for it:

```text
× resolves undefined so a recoverable disconnect never becomes the subagent run result
  IntercomClientDisconnectedError: Client disconnected

× retries after a recoverable warm-up disconnect and unparks the stage
  Error: Test timed out in 30000ms.

× reports once when the bounded attempts run out
  Error: timed out waiting for the expected condition
```

The first is the exact rejection that became the subagent run result. The second
is the stage parked on `ready()` for the full 30 s budget with nothing to unpark
it. The third is the missing diagnostic: no report is ever emitted.

### Green — with the guards

```text
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

Run three consecutive times with no flake. Captured red output:
`/tmp/red-round2.txt`.

## Review round 3 — the broker-side stale socket, and the raw transport error

Two findings, both reproduced on this branch's own code before anything was changed.

**Broker.** `~/.atomic/agent/intercom/broker.log` was sitting at exactly its 8 KiB
cap, 15 of its lines `ERR_STREAM_WRITE_AFTER_END` raised in `writeMessage` from
`IntercomBroker.broadcastToMemberships`. The broker removed a session only on the
socket `'close'` event, so a peer that half-closes — or one the broker itself ended
after refusing a registration — stayed in the routing table and every later
broadcast wrote into a socket whose writable side was gone. Node destroys the
socket synchronously for such a write, so one departure cascaded.

**Client.** `onSocketError` stored a raw post-registration transport error, and
`onClose` then rejected pending work and emitted `disconnected` with it. The
classifier recognizes only `IntercomClientDisconnectedError`, so an established
socket reset bypassed the bounded recovery a clean close already got.

### Red — the three fix files reverted, the new tests kept

`packages/intercom/broker/{broker,send-handler,client}.ts` stashed;
`socket-writes.ts` and the new suites left in place.

```sh
npx vitest --run --project unit \
  test/unit/intercom-broker-stale-session.test.ts \
  test/unit/intercom-broker-socket-writes.test.ts \
  test/unit/intercom-client-transport-disconnect.test.ts
```

```text
 Test Files  3 failed (3)
      Tests  6 failed | 7 passed (13)
```

Each failure is the finding, not a proxy for it:

```text
× fails truthfully, records nothing, and leaves the message id retryable
  AssertionError: expected [{ type: 'delivery_failed', reason: 'Session not found' }]
                  received [{ type: 'delivered' }]

× a broker-ended session is retired, and healthy peers keep working without write-after-end
  AssertionError: session_left arrived after the broadcast:
  ["registered","session_joined","session_joined","session_left"]

× a send to a broker-ended session fails truthfully and keeps the message id retryable
  Error: Timed out waiting for broker frame delivery_failed

× a real post-registration transport error becomes a recoverable disconnect that keeps its cause
  AssertionError: expected the typed error, got Error: write EPIPE

× an ECONNRESET on an established socket enters the recoverable path with its code intact
  AssertionError: ok(error instanceof IntercomClientDisconnectedError)

× a protocol error stays non-recoverable even when a socket error follows it
  AssertionError: /^Intercom protocol error: /u did not match 'read ECONNRESET'
```

The second failure is the sharp one: `session_left` for the refused peer arrived
*after* the `session_joined` broadcast, which is only possible because the
retirement was a side effect of the failing write destroying the socket rather
than a deliberate retirement at the refusal. The third shows the broker answering
`delivered` for a peer that received nothing. The last shows the clobber hazard was
real: a socket error arriving after `onReaderError` overwrote the protocol
diagnosis.

The broker's own log confirms the production stack, byte for byte, from a
throwaway probe against the reverted broker (`/tmp/red-broker-log.mjs`):

```text
ERR_STREAM_WRITE_AFTER_END occurrences: 2
Socket error: Error [ERR_STREAM_WRITE_AFTER_END]: write after end
    at writeMessage (packages/intercom/broker/framing.ts:12:10)
    at IntercomBroker.broadcastToMemberships (packages/intercom/broker/broker.ts:1324:35)
    at IntercomBroker.handleMessage (packages/intercom/broker/broker.ts:971:16)
zombie received the message frame: false
```

### Green — with the lifecycle retirement, the checked write, and the typed reset

```text
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

and the pre-existing evidence is unchanged:

```sh
npx vitest --run --project unit test/unit/intercom-*.test.ts
 Test Files  52 passed (52)
      Tests  467 passed (467)
```

Captured red output: `/tmp/red-round3.txt`.
