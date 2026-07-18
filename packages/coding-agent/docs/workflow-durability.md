# Durability and cross-session resume

Understand what Atomic checkpoints, where durable data lives, how ownership and replay work, and which privacy and retention boundaries apply.

## Durable Workflows and Cross-Session Resume

Atomic workflows use **DBOS/Postgres as their sole persistent workflow backend**. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before workflow execution, resume, inspection, or deletion can access durable state. `DBOS_SYSTEM_DATABASE_URL` may select an existing database; DBOS initialization, query, and write failures fail the workflow action and never select another backend.

**Zero-configuration local database.** Without `DBOS_SYSTEM_DATABASE_URL`, Atomic runs DBOS against its own embedded Postgres built from npm-distributed binaries — no Docker daemon or system Postgres install. The cluster lives under `~/.atomic/postgres/v18` on dedicated port `5439`; the first workflow action initializes it once and starts it with `pg_ctl` as a detached daemon that survives Atomic exiting, is shared by every concurrent Atomic session, and is never stopped by Atomic. When the embedded binaries are unavailable for the platform, Atomic falls back to DBOS's reusable `dbos-db` Docker container; if neither is usable, the workflow action fails with one actionable message: set `DBOS_SYSTEM_DATABASE_URL` to an existing Postgres.

**Multiple concurrent Atomic sessions.** Every Atomic process launches DBOS with a unique executor id, and running root workflows carry owner/heartbeat metadata refreshed by ordinary ≤30-second stage-timing checkpoints. **Running workflows are never resume targets**: a running row with a fresh heartbeat is hidden from every session's picker and refused by direct `/workflow resume <id>` — resuming a workflow that is executing elsewhere would double-dispatch it. Once the heartbeat goes stale (about two minutes after a crash), the workflow surfaces as a red `crashed` row. When two sessions race to resume the same paused workflow, a durable first-writer-wins claim decides exactly one winner; the loser reconciles to the authoritative state and reports that the workflow changed while resume was pending.

### How it works

- **Only `ctx.*` blocks are checkpointed**: code outside `ctx.*` is not durable.
- **Durable side effects**: `ctx.tool` and `ctx.ui` writes are flushed before completed results are exposed, so resume does not repeat an already-completed effect.
- **Durable graph operations**: stage, task, chain, parallel, and child-workflow checkpoints include current topology, timing, model, output, and retained chat-session references. Completed inspection reconstructs the graph directly from DBOS.
- **DBOS-only discovery**: `/workflow resume`, `/workflows`, completed inspection, deletion, and targeted lookup hydrate/query DBOS. Session JSONL is not a workflow catalog or discovery source. With `persistRuns` enabled, it can also contain workflow lifecycle entries with inputs, summaries, errors, outputs, and stage-session references.
- **Current format only**: Atomic encodes and decodes one current DBOS format. Prior local files and older DBOS records are not read, converted, or cleaned up. Unsupported or malformed records are ignored as foreign data.
- **Child side-effect scoping**: nested workflow effects are checkpointed under the durable root with stable child scopes.
- **Cross-session safety**: per-process executor identity, owner/heartbeat liveness on running handles, and claim-guarded status transitions prevent double dispatch when several Atomic sessions share the database.

**Privacy and retention.** DBOS persists workflow inputs, completed tool outputs, UI responses, stage outputs, and chat-session paths. Treat the configured database as sensitive. History has no automatic age/count deletion; confirmed picker deletion removes inactive DBOS workflow state while preserving independent chat transcripts.

**Resume after editing a workflow.** Replay identity combines the workflow id with stable content hashes and call order. Editing, inserting, or reordering `ctx.*` calls can intentionally invalidate matches. Finish or delete retained runs before deploying incompatible workflow changes.

### `ctx.tool` — durable cached tool execution

The `ctx.tool(name, args, fn, options?)` primitive runs arbitrary TypeScript code and caches the result durably. On resume, if that ordinal tool call already completed (matched by call order plus content hash of `name` + `args`), the cached result is returned without re-executing the function — ensuring completed side effects are not repeated while still allowing two intentional same-name/same-args calls in one workflow.

```ts
export default workflow({
  name: "data-pipeline",
  description: "Fetch a dataset once, then analyze its cached contents.",
  inputs: { source: Type.String() },
  outputs: { summary: Type.String() },
  run: async (ctx) => {
    // This side effect is cached durably. On resume, it will NOT re-execute.
    const data = await ctx.tool(
      "fetch-dataset",
      { source: ctx.inputs.source },
      async () => {
        const res = await fetch(ctx.inputs.source);
        return await res.text();
      },
      { retriesAllowed: true, maxAttempts: 3 },
    );

    // Subsequent stages use the cached result.
    const analysis = await ctx.task("analyze", { prompt: `Analyze: ${data}` });
    return { summary: analysis.text };
  },
});
```

### `/workflow resume` — cross-session resume selector

The `/workflow resume` command mirrors `/resume` ergonomics and `/workflows` is its alias. With no id, it builds one newest-first picker from eligible live runs and current DBOS resumable/completed records. DBOS is the authoritative catalog; selected records are hydrated and revalidated before resume or inspection. Running workflows never appear: fresh-heartbeat rows are excluded in every session to prevent double dispatch, and stale ones surface as `crashed`. Rows carry semantic colors — completed green, paused yellow, failed/blocked/crashed red — and the open picker live-updates on local run changes plus a bounded cross-session poll, so state transitions appear (and freshly running workflows disappear) without reopening it.

Only current-format DBOS records are selectable. Unsupported or malformed records remain hidden without reinterpretation.

Selecting a paused, failed, blocked, or crash-recovery target follows the existing resume path unchanged: Atomic re-dispatches the workflow with its cached inputs and the **original workflow id**, so previously completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child workflow boundaries replay from durable checkpoints rather than executing again. Selecting a completed target follows a separate open path. Atomic reconstructs a completed run/stage snapshot from authoritative checkpoints, remaps persisted source-stage parent references to the reconstructed stage ids in two passes, and opens the detail/chat overlay without calling the durable resume dispatcher or re-running workflow stages, tools, tasks, prompts, or workflow code.

Completed detail state is read-only. A retained stage chat may be reopened for follow-up without resuming workflow execution or mutating its DBOS handle. Current checkpoints always include supported topology; foreign checkpoints are excluded rather than displayed with inferred edges.

```text
/workflow resume                          # Mixed picker: resumable + completed
/workflow resume <workflow-id-or-prefix> # Resume unfinished work or open completed detail/chat
/workflows                               # Alias for the same mixed picker
/workflows <workflow-id-or-prefix>        # Alias for targeted resume/open
```

Explicit full IDs take precedence, while prefixes resolve across top-level live, resumable durable, and completed targets as one namespace. An exact loadable paused top-level live target resumes directly from in-session state without enumerating the durable completed-history catalog; this keeps explicit live resume responsive even when retained durable history is large and preserves live-over-durable precedence for duplicate IDs. Nested child runs remain excluded from this top-level target namespace even when addressed by an exact ID. Prefixes and other targets continue through the combined catalog so ambiguity and completed-inspection behavior remain unchanged. Ambiguous prefixes use the existing-style ambiguity diagnostic. A completed backend row with no checkpoints or no usable retained stage conversation is hidden from the picker; an explicit target reports that it is stale or missing required durable checkpoint/session data. A completed run remains inspectable when at least one stage has a usable transcript; missing, empty, directory, context-empty, or partially malformed transcript paths are omitted from stage chat attachment. Validation uses the final retained transcript for a repeated stage replay key, so an obsolete superseded checkpoint path does not hide an otherwise valid completed run. Reopening inspection refreshes a changed authoritative retained-chat handle. Session-cache-only rows are likewise hidden because the backend is authoritative. Cancelled, killed, non-resumable failed, and other terminal non-success states are never added. Normal `/resume`, `atomic -r`, and `--continue` behavior for internal workflow stage sessions is unchanged.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Internally cancelled workflow** | Marked `cancelled` in durable state and excluded from `/workflow resume` discovery. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` or `blocked` and remains resumable by default. `/workflow resume <id>` continues from the last completed checkpoint unless durable metadata explicitly sets `resumable: false`. |
| **Stage failure (non-recoverable)** | Workflow marked `failed` or `blocked` with `resumable: false`, so it is excluded from resume discovery. |
| **Process crash** | Workflow remains `running` in durable state. On next session start, it appears in resume discovery when it has a durable checkpoint or pending prompt. Resume re-executes from the last completed checkpoint. |
| **`ctx.tool` retry** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt and during retry backoff, so later attempts do not run after the workflow is cancelled. After exhausting retries, the error propagates and the workflow fails. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring DBOS/Postgres

DBOS/Postgres is the sole persistent backend. Set `DBOS_SYSTEM_DATABASE_URL` to use an existing database; otherwise Atomic starts its embedded Postgres cluster as described above. DBOS initialization or connectivity failures fail the workflow action rather than silently switching to another backend.

```bash
export DBOS_SYSTEM_DATABASE_URL="postgresql://user:password@localhost:5432/atomic_dbos_sys"
```

When `/workflow resume` lists or resumes a DBOS-backed workflow in a fresh process, Atomic first hydrates its in-memory replay mirror from DBOS. Checkpoints are stored as structured, versioned DBOS outputs containing the checkpoint kind, id, tool argument hash, UI prompt hash, stage replay key, completed output, and additive versioned stage-topology metadata when available, so replay can skip completed `ctx.tool`, `ctx.ui`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and `ctx.workflow` work without relying on prior in-process state and completed inspection can rebuild the original DAG. Atomic updates the in-memory replay mirror for awaited DBOS checkpoints only after DBOS accepts the write, and root metadata is mirrored as versioned DBOS records where the latest timestamp wins during hydration. Unmarked raw-output checkpoint records remain readable as generic stage checkpoints when their workflow has compatible current metadata; marked envelopes with unsupported envelope versions are ignored rather than decoded as raw output, while unsupported or malformed additive topology fields are ignored without dropping an otherwise valid stage envelope.

There is no production file-backed durability fallback. Old files under `~/.atomic/workflow-durable` are not current workflow catalog entries and are neither discovered nor migrated.
