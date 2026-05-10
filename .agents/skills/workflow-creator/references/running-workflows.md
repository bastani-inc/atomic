# Running a Workflow on Behalf of the User

When the user asks you to **run** (or "kick off" / "start" / "execute") a
workflow — *not* author one — your job is to translate their request into the
correct invocation and run it. This includes natural-language requests such as
"run ralph on this repo", "run workflow x with prompt y", or "start the release
workflow with version 1.2.3". Do not reply with instructions for the user to run
unless shell execution is unavailable in your environment; use your terminal
tool to invoke the workflow yourself.

**This playbook works from any context.** Whether you're running in a fresh terminal, inside `atomic chat -a <agent>`, or from a CI script, the decision tree below is the same — atomic builtins, repo examples, and user SDK workflows are all discoverable and invokable through the daemon. The daemon is the single source of truth: every workflow you dispatch is tracked by it and visible to every client that connects.

**Runtime model (atomic 2.0).** `atomic --ui-server` is a per-user singleton daemon. The SDK auto-spawns it on first use and auto-discovers it via `~/.atomic/daemon.endpoint.json`. All workflow control — dispatch, inspection, status, control — goes through JSON-RPC calls to the daemon. There is no tmux dependency.

## Three invocation paths

**Path A — user's own app.** The user wrote one or more composition
roots. Two shapes exist — pick based on what the file calls:

- **Single-workflow worker** (`runWorkflow({ workflow, inputs })`) —
  one file per agent, bound to one `WorkflowDefinition`. The dev wires
  `--<input>` Commander options for each declared input using
  `getInputSchema(wf)`. Typical name: `<agent>-worker.ts`.

  ```bash
  bun run src/<agent>-worker.ts --<field>=<value>      # structured inputs
  bun run src/<agent>-worker.ts "<prompt>"             # positional (if the worker wired [prompt...])
  ```

  `runWorkflow({...})` is a JSON-RPC client call to `workflow/start` on the daemon. The daemon auto-spawns if not running. For detached runs, the dev passes `detach: true` to `runWorkflow` or wires their own `--detach` Commander option. There are no built-in `-n`/`-a`/`-d` flags on user-app workers.

- **Multi-workflow CLI** (`createRegistry()` + `listWorkflows`) —
  a single file that registers many workflows and mounts one Commander
  subcommand per workflow. The subcommand name is the workflow name; each
  subcommand's options are the workflow's declared inputs.

  ```bash
  bun run src/cli.ts <workflow-name> --<field>=<value>
  bun run src/cli.ts <workflow-name> "<prompt>"       # if the subcommand wires [prompt...]
  ```

**Path B — repo-shipped examples.** Inside the Atomic repo each example
directory ships one worker file per agent (`claude-worker.ts`,
`copilot-worker.ts`, `opencode-worker.ts`). Each is a Commander entrypoint
built with `getInputSchema(wf)`:

```bash
bun run examples/<name>/<agent>-worker.ts --<field>=<value>
bun run examples/<name>/<agent>-worker.ts "<prompt>"    # if the worker wires [prompt...]
```

Available examples: `hello-world`, `parallel-hello-world`, `headless-test`,
`hil-favorite-color`, `hil-favorite-color-headless`, `structured-output-demo`,
`reviewer-tool-test` (copilot only). Use these to demonstrate a specific SDK
feature or as a copy-paste starting point.

**Path C — atomic registry.** Workflows registered with the `atomic` CLI. This
includes builtins shipped inside `@bastani/atomic-sdk` and custom workflows
declared in project/global settings (`.atomic/settings.json` and
`~/.atomic/settings.json`):

```bash
atomic workflow -n <name> -a <agent> [inputs...]
atomic workflow list -a <agent>
```

Builtin names: `ralph`, `deep-research-codebase`, `open-claude-design`.

Direct `atomic workflow` runs should always include `-n <name>` and
`-a <agent>`. Use `-d` when launching from an agent or script and you want
the command to return after dispatching the workflow (run continues in daemon, no panel attached).

**Identify the path before anything else.** Decision order:

1. Does `atomic workflow list -a <agent>` include the requested name? →
   **Path C** (`atomic workflow`). This covers builtins and custom workflows.
2. Does `examples/<name>/<agent>-worker.ts` exist in the current repo? →
   **Path B** (`bun run examples/<name>/<agent>-worker.ts`).
3. Does a composition root exist in `src/` (single-workflow
   `runWorkflow({ workflow })` file, or a cli `createRegistry()` + `listWorkflows`
   file)? → **Path A**.
4. None of the above → the workflow doesn't exist. Offer to author it
   (see below).

## Always list first

**Before running, list available workflows.** This is a cheap, read-only
call that confirms whether the named workflow actually exists:

```bash
# Atomic registry: builtins + registered custom workflows
atomic workflow list -a <agent>

# Repo-shipped examples (when inside the atomic repo)
bun run examples/<name>/<agent>-worker.ts --help

# User's own app with an explicit list/help command
bun run src/cli.ts list
```

If the user app has no read-only list/help command, inspect its composition
root instead of running `-n <name> -a <agent>` as a probe — that would start
the workflow when the name is valid.

The list/help output or source inspection tells you:
- Whether the workflow the user named actually exists.
- What other workflows are available (close matches for typos).

Skipping this step is how you end up with a `workflow not found` error you
could have predicted.

If the request is ambiguous ("run the research one"), show the list to the
user and ask with AskUserQuestion.

## If the workflow doesn't exist: offer to create it

When the listed workflows don't include what the user asked for:

1. **Tell the user explicitly** — "I don't see a `<name>` workflow registered.
   Available: \<short list>."
2. **Check for typos first** — if one of the listed names is a close match,
   surface it via AskUserQuestion ("Did you mean `<close-match>`?") before
   offering to author anything.
3. **Offer to create it** — ask with AskUserQuestion: "Want me to create a
   `<name>` workflow first?" with choices `Yes, create it` / `No, pick from
   the list` / `No, cancel`.
4. **If yes → switch modes** — hand off to the authoring flow in SKILL.md.
   Interview the user for intent, write the workflow definition, register it
   in the composition root, typecheck it, *then* come back here and invoke.
   Do not skip the typecheck.
5. **If no → stop** — don't fabricate a command that will fail. Let the user
   redirect you.

Never invent a workflow name or silently fall back to a different workflow.

## Collecting inputs with AskUserQuestion

Once you've confirmed the workflow exists, you need to know two things about
its invocation shape:

1. **Does it declare a `prompt` input?** If so, it's free-form — you pass a
   positional string.
2. **Does it declare structured inputs?** If so, you pass `--<field>=<value>`
   flags, one per required field.

**Use `atomic workflow inputs <name> -a <agent>` to get the schema for registered atomic workflows.** This works for builtins and registered custom workflows. It prints a JSON envelope with every field's `name`, `type`, `required`, `default`, `description`, and (for enums) `values` — exactly what AskUserQuestion needs. The `freeform: true` flag tells you whether the workflow takes a positional prompt vs. structured flags, with a synthetic `prompt` field included so the JSON shape is uniform either way.

```bash
atomic workflow inputs gen-spec -a copilot
# {"workflow":"gen-spec","agent":"copilot","freeform":false,
#  "inputs":[{"name":"research_doc","type":"string","required":true,...},
#            {"name":"focus","type":"enum","values":["minimal","standard","exhaustive"],"default":"standard"}]}
```

For user apps, read the workflow definition's `inputs` array directly or
inspect the TypeScript source — the schema is inline in `defineWorkflow({
inputs: [...] })`. Reading the source is always in sync because `defineWorkflow`
validates the schema at definition time.

`atomic workflow inputs` is for workflows visible to the atomic registry
(builtins plus settings-registered custom workflows). For standalone user-app
workers that are not registered with `atomic workflow list`, read the
`defineWorkflow` source directly.

Once you have the schema, use the **AskUserQuestion tool** to collect any
values the user hasn't already provided in their message. One question per
missing input field. For enum fields, pass the declared `values` as
multiple-choice options so the user sees exactly what's allowed. Keep
questions tight and purposeful — if the user's message already answers a
question, don't ask it again.

Skip AskUserQuestion entirely when:
- The user already supplied every required value in their message
  ("run ralph on 'add OAuth to the API'" — the prompt is right there).
- The workflow declares no required inputs and needs no prompt.

## End-to-end recipe

1. **Resolve the agent** — explicit user request, then `ATOMIC_AGENT`, then ask once. Do not default to Claude.
2. **Identify the invocation path** — atomic registry (`atomic workflow`),
   repo-shipped example (`bun run examples/<name>/<agent>-worker.ts`), or
   the user's own app (single-workflow `src/<agent>-worker.ts` or
   multi-workflow `src/cli.ts`)?
3. **List available workflows** — run the list command for the chosen path.
   This is your ground truth.
4. **Resolve the target**:
   - Exact match in the list → continue.
   - Close match → confirm via AskUserQuestion before proceeding.
   - No match → tell the user what's available and offer to author it (see
     previous section). If they decline, stop.
5. **Discover the inputs schema** — for registered atomic workflows use
   `atomic workflow inputs <name> -a <agent>`; for unregistered user apps inspect the `defineWorkflow` source.
6. **Ask for missing inputs** — use AskUserQuestion, one question per
   unanswered required field. Enums become multiple-choice.
7. **Invoke** — build and execute one of these commands:

   User's own app — single-workflow worker:
   - Free-form: `bun run src/<agent>-worker.ts "<prompt>"` (only if the worker wires `[prompt...]`)
   - Structured: `bun run src/<agent>-worker.ts --field1=val1`
   - Detached: pass `detach: true` to `runWorkflow` or use the dev's own `--detach` option

   User's own app — multi-workflow CLI:
   - Free-form: `bun run src/cli.ts <workflow-name> "<prompt>"` (only if wired)
   - Structured: `bun run src/cli.ts <workflow-name> --field1=val1`
   - Detached: same as above (dev-wired `--detach` or `detach: true`)

   Repo-shipped example (inside atomic repo):
   - Free-form: `bun run examples/<name>/<agent>-worker.ts "<prompt>"` (only if wired)
   - Structured: `bun run examples/<name>/<agent>-worker.ts --field1=val1`

   Atomic registry:
   - Free-form: `atomic workflow -n <name> -a <agent> "<prompt>"`
   - Structured: `atomic workflow -n <name> -a <agent> --<field1>=<value1>`
   - Detached (background, no panel): add `-d`

7. **Tell the user the run id and how to attach** — the runtime prints a
   `runId` when the workflow dispatches. Immediately echo it back with the
   attach instruction described in §"After starting: tell the user how to
   attach" below. This is non-negotiable on every successful dispatch. Also
   surface `run/status` (poll) and `run/stop` (stop).
8. **If you started the workflow detached (`-d` or `detach: true`), poll
   status until it terminates or pauses for input** — see "Polling rhythm
   after spawning" below. Surfacing a HIL pause to the user immediately is
   non-negotiable; an unattended `awaiting_input` / `needs_review` state
   means the workflow is wedged and the user doesn't know.

## After starting: tell the user how to attach

**Rule:** Every time you successfully start a workflow on the user's behalf, your *very next message* must tell them the `runId` and how to attach to the live panel. Do not bury this in a status report or a summary — it is the headline of the post-dispatch message.

The runtime prints a `runId` when the workflow dispatches (e.g. `a1b2c3d4`). Capture that exact string and use it verbatim — do not paraphrase, abbreviate, or invent placeholder ids. The user must be able to copy-paste the command.

**Phrasing template** — substitute `<name>` with the workflow name and `<runId>` with the literal run id printed:

> Started workflow `<name>` (run id: `<runId>`). To watch it run interactively, open a new terminal and run:
>
> ```
> atomic workflow attach <runId>
> ```

**Why "open a new terminal":** `atomic workflow attach` mounts an OpenTUI panel client that takes over the terminal's stdin/stdout. If the user runs it in the same shell hosting their chat session, they lose the chat for the duration. A second terminal lets the workflow run visibly while the user keeps talking to you. Always say "open a new terminal."

**Multi-attach is supported.** Multiple terminals can run `atomic workflow attach <runId>` simultaneously — each gets its own independent OpenTUI client subscribed to the daemon's `panel/update` stream. Inform the user if they ask about watching from multiple places.

**Worked phrasing — copy this shape verbatim, swapping the ids:**

> Started workflow `gen-spec` (run id: `a1b2c3d4`). To watch it run interactively, open a new terminal and run:
>
> ```
> atomic workflow attach a1b2c3d4
> ```
>
> Status: `atomic workflow status a1b2c3d4`
> Stop: `atomic workflow stop a1b2c3d4`

If the runtime did *not* print a run id (rare — usually a startup error or daemon unreachable), do not fabricate one. Tell the user the workflow failed to start and surface the actual error output instead.

## Dispatching from the SDK

`runWorkflow({...})` sends `workflow/start` to the daemon over JSON-RPC and returns a `runId`. The daemon auto-spawns if not running. SDK-side dispatch:

```ts
const { runId } = await runWorkflow({ workflow, inputs });
// runId is the handle for all subsequent run/* calls
```

The daemon auto-discovers its endpoint from `~/.atomic/daemon.endpoint.json`. SDK consumers never manage the daemon lifecycle directly.

## Polling rhythm after spawning

When the workflow runs detached (you dispatched with `-d` or the user wants
to keep working while it executes), the model is responsible for tracking
its progress. Use `run/status` (via `atomic workflow status <runId>`):

```bash
atomic workflow status <runId>
# JSON envelope; key field is `overall`:
#   in_progress    → keep polling at a sensible cadence
#   awaiting_input → surface to user *now* — see HIL response below
#   needs_review   → surface to user *now* — same handling
#   completed      → report success + summarize the snapshot's stage results
#   error          → report `fatalError` + offer to investigate
```

Polling cadence: every 30–60s for runs that should take minutes; every 2–5
minutes for long runs (e.g. `ralph` iterating). Don't busy-poll. If the
user asks "is it done yet?" mid-run, run `status` once and answer from the
result — don't kick off a new poll loop on every question.

### What to do on `awaiting_input` or `needs_review`

These states mean a stage is waiting on a typed answer (an `AskUserQuestion`
elicitation, a Copilot `ask_user`, an OpenCode `question.asked`, or a
review-marker handoff). The workflow will sit forever unless the user
responds.

The response path is **interactive attach**:

```bash
atomic workflow attach <runId>
# User sees the live OpenTUI panel, types their answer into the agent's pane,
# detaches with the panel's standard key binding
```

Input forwarded by the panel client goes to the daemon via `pane/sendInput`, which writes it to the agent subprocess's PTY. There is no `atomic workflow send <runId> --message "..."` public command — agent panes accept input only through the live panel.

So when you see `awaiting_input` or `needs_review`:

1. Stop polling.
2. Read the snapshot's stages to find which one is paused (`status: "awaiting_input"`).
3. Tell the user **plainly and immediately**: "Workflow `<name>` is paused on stage `<stage-name>` waiting for your input. Attach with `atomic workflow attach <runId>` to respond." Include the stage name so the user knows what they're answering.
4. Wait for the user to confirm they've responded (or for the next status poll to show `in_progress` again) before resuming the polling rhythm.

### Inspecting run state

Two surfaces:

**`atomic workflow status <runId>`** — returns a `WorkflowStatusSnapshot` including `overall` status and per-stage states. Pass no id to list all runs: `atomic workflow status`.

**`run/transcript`** — retrieve the saved `SavedMessage[]` for a completed stage. Use `atomic workflow transcript <runId> <stageName>` (or the equivalent SDK call). Cheaper than attaching when you just want to read what an agent produced.

**`atomic workflow read --runId <runId>`** — resolves on-disk artifacts under `~/.atomic/sessions/<runId>/`:

```bash
# Run-level: list the run dir and discover available stages.
atomic workflow read --runId a1b2c3d4
# {
#   "ok": true,
#   "runId": "a1b2c3d4",
#   "path": "/home/u/.atomic/sessions/a1b2c3d4",
#   "stages": ["scout", "explore", "synth"],
#   "files": [{"name":"status.json","kind":"file","size":1234}, …]
# }

# Stage-level: resolve the single stage subdir + list its saved artifacts.
atomic workflow read --runId a1b2c3d4 --stageId scout
# {
#   "ok": true,
#   "runId": "a1b2c3d4",
#   "stageName": "scout",
#   "path": "/home/u/.atomic/sessions/a1b2c3d4/scout-9f8e7d6c",
#   "files": [
#     {"name":"messages.json","kind":"file","size":8123},
#     {"name":"inbox.md","kind":"file","size":3401},
#     {"name":"metadata.json","kind":"file","size":312}
#   ]
# }
```

**Key files under `<runId>/`:**

| File / dir                                     | What's in it                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `status.json`                                  | Panel snapshot — same JSON `atomic workflow status <runId>` returns                        |
| `metadata.json`                                | Workflow-level metadata: name, agent, prompt, project root, `startedAt`                   |
| `<stageName>-<stageSessionId>/messages.json`   | `SavedMessage[]` produced by `s.save(...)` in that stage. Schema is provider-specific.    |
| `<stageName>-<stageSessionId>/inbox.md`        | Plain-text rendering of `messages.json`. Cheaper than JSON for reading agent output.      |
| `<stageName>-<stageSessionId>/metadata.json`   | Stage metadata: name, description, agent, `startedAt`                                     |
| `<stageName>-<stageSessionId>/error.txt`       | Present **only** when the stage failed; contains the error message.                       |

**Typical model flow** when investigating a stalled or completed run:

1. `atomic workflow status <runId>` — see overall + per-stage states.
2. Pick a stage of interest (`needs_review` / `error` / `completed`).
3. `atomic workflow read --runId <runId> --stageId <stage>` — get its absolute dir.
4. `Read` the file you actually want (`inbox.md` for human-readable, `messages.json` for raw, `error.txt` for a failure trace).

### Tracking multiple workflows

`atomic workflow status` (no id) issues `run/list` to the daemon and returns all runs:

```bash
atomic workflow status
# {"runs":[{"runId":"…","overall":"in_progress",...},
#          {"runId":"…","overall":"needs_review",...}]}
```

Useful when the user has several runs going. Sort by `overall` priority —
surface every `needs_review` / `awaiting_input` first, then `error`, then
`in_progress`. `completed` runs can be reported in summary.

## Monitoring a running workflow

All three invocation paths (Path A, B, C) dispatch through the same daemon. Monitoring surfaces:

```bash
atomic workflow status <runId>           # run/status — JSON snapshot
atomic workflow attach <runId>           # mount OpenTUI panel client (new terminal)
atomic workflow stop <runId>             # run/stop — SIGTERM to agent subprocess(es)
```

No-global-install fallback — `bunx atomic`. The `atomic` CLI ships as a
separate package (`@bastani/atomic`) from the SDK (`@bastani/atomic-sdk`).
Add it with `bun add @bastani/atomic` and use `bunx atomic …` in place of
`atomic …`. Skip if the global binary is already on `PATH`.

`runWorkflow` does **not** auto-register monitoring subcommands on user-app
worker files. If the dev wants those commands inside their own CLI, they
wire them using SDK primitives:

```ts
import {
  runWorkflow,
  connectToDaemon,
} from "@bastani/atomic-sdk/workflows";

// After runWorkflow returns a runId, use the daemon connection:
const conn = await connectToDaemon();
const status = await conn.sendRequest("run/status", { runId });
const transcript = await conn.sendRequest("run/transcript", { runId, sessionName: "step-1" });
await conn.sendRequest("run/stop", { runId });
```

Detached workflows (launched with `-d` or `detach: true`) dispatch immediately and return. The daemon keeps the run alive. Use `run/status` to poll progress without attaching a panel.

Five overall states the agent must handle distinctly:

| Status | Meaning | What you should do |
|---|---|---|
| `in_progress` | Daemon is running stages and no stage is paused | Wait, or report progress to the user |
| `awaiting_input` | A stage is mid-`AskUserQuestion` (or equivalent HIL primitive) and the SDK has emitted the elicitation event — no transcript-level review marker set yet | **Surface this to the user immediately** — same UX as `needs_review`. Session blocked waiting on a typed answer; nothing else will happen until the user attaches and responds |
| `needs_review` | At least one stage is paused for human input (HIL) — Copilot `ask_user`, OpenCode `question.asked`, Copilot/MCP elicitation, or a transcript-marker handoff that survives across detach/reattach | **Surface this to the user immediately** — they need to `atomic workflow attach <runId>` to respond, otherwise the workflow stalls indefinitely |
| `completed` | Workflow finished successfully | Report success and summarize the output |
| `error` | Fatal error or a stage failed | Report the `fatalError` field and offer to investigate logs |

`awaiting_input` and `needs_review` both outrank `completed` so a HIL pause
near the end is never reported as done while still waiting on a human.

## Stopping a run

When the user is done with a workflow, or you dispatched one that's no longer needed:

```bash
atomic workflow stop <runId>
# Equivalent SDK RPC: conn.sendRequest("run/stop", { runId })
```

The daemon sends SIGTERM to the agent subprocess(es) and cleans up the run. Unlike the 1.x `session kill`, there is no `-y` flag — the daemon's `run/stop` is non-interactive by design.

## Worked examples

**Example A — atomic registry, structured inputs**

> **User:** "run gen-spec on research/docs/2026-04-11-auth.md"

*(Note: `gen-spec` is a hypothetical builtin used here for pedagogical purposes. Real atomic builtins are `ralph`, `deep-research-codebase`, and `open-claude-design`.)*

1. Resolve the agent from the user request or `ATOMIC_AGENT` (example: `claude`).
2. Path C (atomic registry). Run `atomic workflow list -a claude`. Output includes `gen-spec`. Good.
3. Target resolved exactly: `gen-spec`.
4. Run `atomic workflow inputs gen-spec -a claude`. Parse the JSON:
   `research_doc` (required string — already given), `focus` (required enum
   of `minimal|standard|exhaustive`, default `standard`), `notes`
   (optional text).
5. Ask via AskUserQuestion once: "What focus level for the spec?" with
   choices `minimal`, `standard`, `exhaustive`. User picks `standard`. Skip
   `notes` since it's optional.
5. Run: `atomic workflow -n gen-spec -a claude --research_doc=research/docs/2026-04-11-auth.md --focus=standard`
6. The CLI prints a run id like `a1b2c3d4`.
   Tell the user:
   "Started workflow `gen-spec` (run id: `a1b2c3d4`).
   To watch it run interactively, **open a new terminal** and run:
   `atomic workflow attach a1b2c3d4`.
   Status: `atomic workflow status a1b2c3d4`.
   Stop: `atomic workflow stop a1b2c3d4`."

**Example B — user app, free-form prompt**

> **User:** "run the summarize-pr workflow on 'add OAuth to the API'"

1. Resolve the agent from the user request or `ATOMIC_AGENT` (example: `opencode`).
2. Path A. `src/opencode-worker.ts` exists and calls `runWorkflow(summarizePrOpenCode)`.
   (If instead the user had a `src/cli.ts` with `createRegistry()` + `listWorkflows`,
   run `bun run src/cli.ts --help` to see the registered subcommands and confirm `summarize-pr`.)
3. Target resolved exactly: `summarize-pr`, agent `opencode`.
4. Prompt already given in user's message. No AskUserQuestion needed. Check
   `defineWorkflow` source to confirm `prompt` is a declared input.
5. Run: `bun run src/opencode-worker.ts --prompt="add OAuth to the API"`.
   (If the worker was built with a `[prompt...]` Commander argument, the positional
   form `bun run src/claude-worker.ts "add OAuth to the API"` works too.)
   The daemon prints a run id like `b5c6d7e8`.
   For a detached run, the worker must wire `detach: true` to `runWorkflow` or
   expose its own `--detach` Commander option — there is no built-in `-d` on
   user-app workers.
5. Tell the user:
   "Started workflow `summarize-pr` (run id: `b5c6d7e8`).
   To watch it run interactively, **open a new terminal** and run:
   `atomic workflow attach b5c6d7e8`.
   Status: `atomic workflow status b5c6d7e8`.
   Stop: `atomic workflow stop b5c6d7e8`."

**Example B1b — repo-shipped example, structured inputs**

> **User:** "run the hello-world example with a formal greeting"

1. Resolve the agent from the user request or `ATOMIC_AGENT` (example: `copilot`).
2. Not in the atomic registry for `copilot`. Check `examples/hello-world/copilot-worker.ts` — it exists.
   Path B.
3. Target resolved: `hello-world`, via `examples/hello-world/copilot-worker.ts`.
4. Read `examples/hello-world/copilot/index.ts` for the input schema:
   `greeting` (string, required), `style` (enum: formal/casual/robotic,
   default casual), `notes` (text, optional).
5. Ask via AskUserQuestion: "What should the greeting text be?" User
   supplies `"Hello there"`. `style=formal` is implied by the message.
5. Run: `bun run examples/hello-world/claude-worker.ts --greeting="Hello there" --style=formal`
6. Apply the §"After starting" rule. Tell the user the run id and attach command.

**Example B2 — atomic registry, free-form prompt**

> **User:** "run ralph on 'add OAuth to the API'"

1. Path C (atomic builtin — `ralph` is shipped inside `@bastani/atomic-sdk`).
   Run `atomic workflow list`. Confirms `ralph` is registered.
2. Target resolved exactly: `ralph`, agent `claude`.
3. Prompt already given in user's message. No AskUserQuestion needed.
4. Run: `atomic workflow -n ralph -a claude "add OAuth to the API"`.
5. Apply the §"After starting" rule. Tell the user the run id and attach command.

**Example C — workflow does not exist**

> **User:** "run the security-audit workflow on src/auth"

1. This sounds like a user app workflow. Run `bun run src/cli.ts --help` to
   list available subcommands. Output shows: `summarize-pr`, `triage-pr`. No `security-audit`.
2. Tell the user: "I don't see a `security-audit` workflow registered. Available: summarize-pr, triage-pr."
3. Ask via AskUserQuestion: "Want me to create a `security-audit` workflow
   first?" with choices `Yes, create it`, `No, use one of the existing
   workflows`, `No, cancel`.
4. If **Yes**: switch to SKILL.md's Authoring Process — interview the user
   for what the workflow should do, write the definition, register it in the
   composition root, typecheck, *then* return here and invoke.
5. If **No, use existing**: ask which one via AskUserQuestion, then continue.
6. If **Cancel**: stop, no command runs.

## Common mistakes to avoid

- **Not identifying the invocation path** — using `atomic workflow` for a
  user app, or `bun run src/worker.ts` for a registry workflow or a
  repo-shipped example, leads to "not found". Check the three paths in order
  (atomic registry → examples/ → user app) first.
- **Skipping the list command** — leads to guessing and `workflow not found`
  errors. Always list first.
- **Using `-n`/`-a`/`-d` on user-app workers** — these flags only exist on
  the `atomic` binary for registry workflows. User-app workers expose per-input `--<flag>`
  options and (optionally) a positional `[prompt...]` argument. There is no
  `-n`, `-a`, or `-d` built into user-app workers.
- **Inventing a workflow name** — if it's not in the list, it doesn't exist.
  Say so and offer to author it.
- **For registered atomic workflows: reading the source to discover inputs** — use
  `atomic workflow inputs <name> -a <agent>` instead. JSON, always in sync.
- **Asking everything at once** — let AskUserQuestion drive one question per
  field. Enum fields are multiple-choice, not free text.
- **Re-asking what the user already said** — read their message first.
- **Forgetting to report the run id** — the user needs it to attach and to query status later.
- **Reporting the run id without the attach command** — every successful dispatch must tell the user, in the *same message*, to **open a new terminal** and run `atomic workflow attach <runId>`. Omitting it leaves the user with an id and no idea how to watch the workflow run.
- **Telling the user to attach in their current terminal** — `atomic workflow attach` mounts an OpenTUI panel that takes over stdin/stdout, so attaching in the chat shell ends the chat. Always say "open a new terminal."
- **Leaving `needs_review` unreported** — when status returns `needs_review`, surface it to the user right away. The workflow is blocked on human input and will sit forever otherwise.
- **Using `run/stop` without waiting for confirmation** — `run/stop` sends SIGTERM. Verify the user wants to stop before calling it on their behalf.
