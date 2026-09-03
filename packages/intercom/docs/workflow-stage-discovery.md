# Workflow-stage discovery

Join a workflow invocation group (`workflow:<rootRunId>`) and call `intercom({ action: "list" })` (`intercom list`). In addition to ordinary connected sessions, the result shows:

- **PENDING** materialized stages whose sessions have not initialized, with a canonical `workflow:<rootRunId>/<segment>[/<segment>...]` target for durable delivery before the first model turn.
- **RUNNING** materialized stages connected to Intercom; the same canonical target delivers immediately.
- **Possible future stages** from the scan persisted when the run launched. Literal names, glob patterns, and nested child paths each show their exact canonical target and current queued/sticky count.

Each path segment may be a stage name, a materialized run id, or a glob. `*` matches one segment and may be embedded, as in `reviewer-*`; `**` matches any depth. `workflow:<rootRunId>/**` is the run-wide broadcast: it reaches every live stage through ordinary Intercom now and remains sticky for every future stage, including descendants, until the root terminates. A narrower name or pattern send likewise delivers to every future matching stage.

The persisted possible-stage set is advisory. A syntactically valid path outside it is queued speculatively and acknowledged with `notInKnownSet: true`. If the entry never matches before the run terminates, acknowledgment-requesting senders receive the correlated undeliverable notification; a sticky entry delivered at least once is not reported undeliverable.

A stage whose workflow store status is running is listed only while its Intercom session is live, so it disappears from the roster while the broker is down. It returns once automatic reconnect succeeds, and its canonical path target and final-segment name variant begin delivering together. No Intercom call inside the stage is needed to bring it back.

Roster visibility and delivery follow an asymmetric invocation-control invariant. The invocation group has asymmetric exact-target control over its owned subgroups; ownership does not grant reverse or lateral access. A session in `workflow:<rootRunId>` can list and target stages in owned `workflow:<rootRunId>/...` subgroups; subgroup members cannot reach siblings, other root runs, or unrelated sessions. Each row reports the stage's actual subgroup. Explicit `group: "default"` is not owned. The SDK `sessionId` shown by `workflow status` is not an Intercom target.

Pending delivery retains its 50-message per-target cap. Queued messages arrive under **Messages received before you started** and pattern entries deliver exactly once to each matching materialized stage. Use `ask` only for a live, reply-capable exact target; pending, future, and pattern asks remain unsupported.
