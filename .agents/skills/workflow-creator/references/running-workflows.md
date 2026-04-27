# Running a Workflow on Behalf of the User

When the user asks you to **run** (or "kick off" / "start" / "execute") a
workflow — *not* author one — your job is to translate their request into the
correct invocation and run it. This is the playbook for that flow. It is
different from the authoring playbook in `SKILL.md`: the workflow already
exists in a registry; you just need to invoke it correctly.

**This playbook works from any context.** Whether you're running in a fresh terminal, inside `atomic chat -a <agent>`, or from a CI script, the decision tree below is the same — atomic builtins, repo examples, and user SDK workflows are all discoverable and invokable. If the user is chatting with you through `atomic chat` and says "start my hello-world workflow", walk the same three paths; the shared tmux socket means the workflow you spawn will be visible to every monitoring surface (the worker CLI's own `status` / `session` subcommands, `atomic workflow status`, and `bunx atomic …`) regardless of which path you used to start it.

## Three invocation paths

**Path A — user's own app.** The user wrote one or more composition
roots. Two shapes exist — pick based on what the file calls:

- **Single-workflow worker** (`runWorkflow({ workflow, inputs })`) —
  one file per agent, bound to one `WorkflowDefinition`. The dev wires
  `--<input>` Commander options for each declared input using
  `getInputSchema(wf)`. Typical name: `claude-worker.ts`.

  ```bash
  bun run src/claude-worker.ts --<field>=<value>      # structured inputs
  bun run src/claude-worker.ts "<prompt>"             # positional (if the worker wired [prompt...])
  ```

  For detached runs, the dev passes `detach: true` to `runWorkflow` or
  wires their own `--detach` Commander option. There are no built-in
  `-n`/`-a`/`-d` flags on user-app workers.

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
bun run examples/<name>/claude-worker.ts --<field>=<value>
bun run examples/<name>/copilot-worker.ts "<prompt>"    # if the worker wires [prompt...]
```

Available examples: `hello-world`, `parallel-hello-world`, `headless-test`,
`hil-favorite-color`, `hil-favorite-color-headless`, `structured-output-demo`,
`reviewer-tool-test` (copilot only). Use these to demonstrate a specific SDK
feature or as a copy-paste starting point.

**Path C — atomic builtins.** Workflows shipped inside `@bastani/atomic`
and registered via `createBuiltinRegistry()` inside the `atomic` CLI:

```bash
atomic workflow -n <name> -a <agent> [inputs...]
atomic workflow list
```

Builtin names: `ralph`, `deep-research-codebase`, `open-claude-design`.

Direct `atomic workflow` runs should always include `-n <name>` and
`-a <agent>`. Use `-d` when launching from an agent or script and you want
the command to return after spawning the workflow.

**Identify the path before anything else.** Decision order:

1. Is the name one of the three builtins (`ralph`, `deep-research-codebase`,
   `open-claude-design`)? → **Path C** (`atomic workflow`).
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
# Atomic builtins
atomic workflow list

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

**Use `atomic workflow inputs <name> -a <agent>` to get the schema for atomic builtins.** This prints a JSON envelope with every field's `name`, `type`, `required`, `default`, `description`, and (for enums) `values` — exactly what AskUserQuestion needs. The `freeform: true` flag tells you whether the workflow takes a positional prompt vs. structured flags, with a synthetic `prompt` field included so the JSON shape is uniform either way.

```bash
atomic workflow inputs gen-spec -a claude
# {"workflow":"gen-spec","agent":"claude","freeform":false,
#  "inputs":[{"name":"research_doc","type":"string","required":true,...},
#            {"name":"focus","type":"enum","values":["minimal","standard","exhaustive"],"default":"standard"}]}
```

For user apps, read the workflow definition's `inputs` array directly or
inspect the TypeScript source — the schema is inline in `defineWorkflow({
inputs: [...] })`. Reading the source is always in sync because `defineWorkflow`
validates the schema at definition time.

`atomic workflow inputs` is a builtin-only command — it queries the
internal builtin registry and is not available for user apps. For user
app workflows, always read the `defineWorkflow` source directly.

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

1. **Identify the invocation path** — atomic builtin (`atomic workflow`),
   repo-shipped example (`bun run examples/<name>/<agent>-worker.ts`), or
   the user's own app (single-workflow `src/<agent>-worker.ts` or
   multi-workflow `src/cli.ts`)?
2. **List available workflows** — run the list command for the chosen path.
   This is your ground truth.
3. **Resolve the target**:
   - Exact match in the list → continue.
   - Close match → confirm via AskUserQuestion before proceeding.
   - No match → tell the user what's available and offer to author it (see
     previous section). If they decline, stop.
4. **Discover the inputs schema** — for builtins use `atomic workflow inputs
   <name> -a <agent>`; for user apps inspect the `defineWorkflow` source.
5. **Ask for missing inputs** — use AskUserQuestion, one question per
   unanswered required field. Enums become multiple-choice.
6. **Invoke** — build one of these commands:

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

   Atomic builtins:
   - Free-form: `atomic workflow -n <name> -a <agent> "<prompt>"`
   - Structured: `atomic workflow -n <name> -a <agent> --<field1>=<value1>`
   - Detached: add `-d`

7. **Report the session name** the CLI printed and tell the user: "attach any
   time with `atomic workflow session connect <session>` — or
   `atomic workflow session list` to see what's running."

## Monitoring a running workflow

All three invocation paths (Path A, B, C) spawn sessions on the same `atomic`
tmux socket. Two surfaces expose monitoring commands:

1. **The global `atomic` binary (recommended for all paths).** Session
   management lives under `atomic session …` and `atomic workflow status`:
   ```bash
   atomic session list
   atomic workflow status <session-id>
   atomic session connect <session-id>
   atomic session kill <session-id> -y
   ```
2. **SDK-only fallback — `bunx atomic`.** Any project with `@bastani/atomic`
   as a dep ships the full `atomic` binary at `node_modules/.bin/atomic`. Use
   this when the global binary is not installed.

`runWorkflow` does **not** auto-register `session` or `status` subcommands on
user-app worker files. If the dev wants those commands inside their own CLI,
they wire them explicitly using the SDK session primitives:

```ts
import {
  listSessions,
  stopSession,
  attachSession,
  getSessionStatus,
} from "@bastani/atomic/workflows";
```

Because every workflow lands on the same atomic tmux socket regardless of
which path spawned it, the `atomic` CLI commands work for Path A and B
workflows just as well as for atomic builtins.

Detached workflows return immediately with a session name; the actual work
runs in the background. Use `status` to check whether the workflow is still
running, has completed, errored out, or paused for human input — without
attaching to its TUI.

```bash
# Via the global `atomic` CLI:
atomic workflow status atomic-wf-claude-gen-spec-a1b2c3d4

# Via bunx atomic (SDK-only, no global install):
bunx atomic workflow status atomic-wf-claude-gen-spec-a1b2c3d4

# Output:
# {"id":"atomic-wf-claude-gen-spec-a1b2c3d4","overall":"in_progress","alive":true,
#  "sessions":[{"name":"orchestrator","status":"running",...}],...}
```

Four overall states the agent must handle distinctly:

| Status | Meaning | What you should do |
|---|---|---|
| `in_progress` | The orchestrator is running and no stage is paused | Wait, or report progress to the user |
| `needs_review` | At least one stage is paused for human input (HIL) — Copilot `ask_user`, OpenCode `question.asked`, Copilot/MCP elicitation | **Surface this to the user immediately** — they need to attach with `atomic workflow session connect <id>` to respond, otherwise the workflow stalls indefinitely |
| `completed` | Workflow finished successfully | Report success and summarize the output |
| `error` | Fatal error or a stage failed | Report the `fatalError` field and offer to investigate logs |

`needs_review` outranks `completed` so a HIL pause near the end is never
reported as done while still waiting on a human. A dead orchestrator with a
stale snapshot is automatically downgraded to `error`.

Omit the id to list every running workflow at once: `atomic workflow status`.
Useful when checking on multiple parallel runs, or when the user just asks
"what's running?".

## Cleaning up sessions

When the user is done with a workflow — or you launched one detached and it's
no longer needed — tear it down with `-y` so no confirmation prompt blocks you:

```bash
# Via the global atomic binary (works for all three paths — same tmux socket):
atomic session kill atomic-wf-claude-gen-spec-a1b2c3d4 -y

# Via bunx atomic (SDK-only, no global install):
bunx atomic session kill atomic-wf-claude-gen-spec-a1b2c3d4 -y
```

The `-y` flag is mandatory for agent use. Without it, the CLI calls
`@clack/prompts confirm`, which expects a TTY and will hang indefinitely in a
non-interactive context. Same flag works for `atomic workflow session kill`
and `atomic chat session kill`. Without an id, `kill -y` tears down every
in-scope session — only do that when the user has asked to stop everything.

## Worked examples

**Example A — atomic builtin, structured inputs**

> **User:** "run gen-spec on research/docs/2026-04-11-auth.md"

*(Note: `gen-spec` is a hypothetical builtin used here for pedagogical purposes. Real atomic builtins are `ralph`, `deep-research-codebase`, and `open-claude-design`.)*

1. Path C (atomic builtin). Run `atomic workflow list`. Output includes `gen-spec`. Good.
2. Target resolved exactly: `gen-spec`.
3. Run `atomic workflow inputs gen-spec -a claude`. Parse the JSON:
   `research_doc` (required string — already given), `focus` (required enum
   of `minimal|standard|exhaustive`, default `standard`), `notes`
   (optional text).
4. Ask via AskUserQuestion once: "What focus level for the spec?" with
   choices `minimal`, `standard`, `exhaustive`. User picks `standard`. Skip
   `notes` since it's optional.
5. Run: `atomic workflow -n gen-spec -a claude --research_doc=research/docs/2026-04-11-auth.md --focus=standard`
6. The CLI prints a session name like `atomic-wf-claude-gen-spec-a1b2c3d4`.
   Tell the user: "Started in the background. Attach with
   `atomic workflow session connect atomic-wf-claude-gen-spec-a1b2c3d4`,
   check progress with `atomic workflow status atomic-wf-claude-gen-spec-a1b2c3d4`,
   or stop it with `atomic session kill atomic-wf-claude-gen-spec-a1b2c3d4 -y`."

**Example B — user app, free-form prompt**

> **User:** "run the summarize-pr workflow on 'add OAuth to the API'"

1. Path A. `src/claude-worker.ts` exists and calls `runWorkflow(summarizePrClaude)`.
   (If instead the user had a `src/cli.ts` with `createRegistry()` + `listWorkflows`,
   run `bun run src/cli.ts --help` to see the registered subcommands and confirm `summarize-pr`.)
2. Target resolved exactly: `summarize-pr`, agent `claude`.
3. Prompt already given in user's message. No AskUserQuestion needed. Check
   `defineWorkflow` source to confirm `prompt` is a declared input.
4. Run: `bun run src/claude-worker.ts --prompt="add OAuth to the API"`.
   (If the worker was built with a `[prompt...]` Commander argument, the positional
   form `bun run src/claude-worker.ts "add OAuth to the API"` works too.)
   The runtime prints a session name like `atomic-wf-claude-summarize-pr-a1b2c3d4`.
   For a detached run, the worker must wire `detach: true` to `runWorkflow` or
   expose its own `--detach` Commander option — there is no built-in `-d` on
   user-app workers.
5. Report monitoring commands using the global `atomic` CLI (recommended — no
   extra setup, works for all three paths):
   - "Attach: `atomic session connect atomic-wf-claude-summarize-pr-a1b2c3d4`"
   - "Status: `atomic workflow status atomic-wf-claude-summarize-pr-a1b2c3d4`"
   - "Stop: `atomic session kill atomic-wf-claude-summarize-pr-a1b2c3d4 -y`"
6. `bunx atomic …` is equivalent if the global binary is not installed. Both
   talk to the same atomic tmux socket regardless of which path spawned the
   workflow.

**Example B1b — repo-shipped example, structured inputs**

> **User:** "run the hello-world example with a formal greeting"

1. Not a builtin name. Check `examples/hello-world/claude-worker.ts` — it exists.
   Path B.
2. Target resolved: `hello-world`, via `examples/hello-world/claude-worker.ts`.
3. Read `examples/hello-world/claude/index.ts` for the input schema:
   `greeting` (string, required), `style` (enum: formal/casual/robotic,
   default casual), `notes` (text, optional).
4. Ask via AskUserQuestion: "What should the greeting text be?" User
   supplies `"Hello there"`. `style=formal` is implied by the message.
5. Run: `bun run examples/hello-world/claude-worker.ts --greeting="Hello there" --style=formal`
6. Report the session name.

**Example B2 — atomic builtin, free-form prompt**

> **User:** "run ralph on 'add OAuth to the API'"

1. Path C (atomic builtin — `ralph` is shipped inside `@bastani/atomic`).
   Run `atomic workflow list`. Confirms `ralph` is registered.
2. Target resolved exactly: `ralph`, agent `claude`.
3. Prompt already given in user's message. No AskUserQuestion needed.
4. Run: `atomic workflow -n ralph -a claude "add OAuth to the API"`.
5. Report the session name.

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
  user app, or `bun run src/worker.ts` for a builtin or a repo-shipped
  example, leads to "not found". Check the three paths in order (builtin
  → examples/ → user app) first.
- **Skipping the list command** — leads to guessing and `workflow not found`
  errors. Always list first.
- **Using `-n`/`-a`/`-d` on user-app workers** — these flags only exist on
  the `atomic` binary for builtins. User-app workers expose per-input `--<flag>`
  options and (optionally) a positional `[prompt...]` argument. There is no
  `-n`, `-a`, or `-d` built into user-app workers.
- **Inventing a workflow name** — if it's not in the list, it doesn't exist.
  Say so and offer to author it.
- **For builtins: reading the source to discover inputs** — use
  `atomic workflow inputs <name> -a <agent>` instead. JSON, always in sync.
- **Asking everything at once** — let AskUserQuestion drive one question per
  field. Enum fields are multiple-choice, not free text.
- **Re-asking what the user already said** — read their message first.
- **Forgetting to report the session name** — the user needs it to reattach
  and to query status later.
- **Leaving `needs_review` unreported** — when `atomic workflow status`
  returns `needs_review`, surface it to the user right away. The workflow is
  blocked on human input and will sit forever otherwise.
- **Calling `session kill` without `-y`** — the prompt hangs in a
  non-interactive context. Always pass `-y` from an agent.
