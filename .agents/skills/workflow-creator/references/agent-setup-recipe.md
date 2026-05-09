# Agent Setup Recipe

A deterministic recipe for getting a user from "empty terminal" to "first workflow runs" in one session. This is the path to follow whenever the user signals they want to start using the workflow SDK from zero — phrases like *"set me up with the workflow SDK"*, *"I want to write workflows"*, *"bootstrap a workflow project"*, *"how do I get started"*, or any equivalent. If the user already has `@bastani/atomic-sdk` installed and a workflow file exists, jump to step 5.

## Pick the mode first (see SKILL.md §"Custom workflow modes")

Two distinct setup tracks share Steps 1–3, then branch at Step 4:

- **Mode 1 — Atomic-managed.** The default. Workflow lives in `.atomic/workflows/<name>/` (project) or `~/.atomic/workflows/<name>/` (global) as a self-contained Bun package, registered in `settings.json`, invoked via `atomic workflow -n <name>`. Branch to **Step 4-Mode1** and **Step 5-Mode1**.
- **Mode 2 — Dev-owned CLI.** Workflow lives in `<repo>/src/workflows/<name>/<agent>.ts` with a Commander composition root in `<repo>/src/<agent>-worker.ts`. Branch to **Step 4-Mode2** and **Step 5-Mode2**.
- **Combined.** Author as Mode 2 but call `await hostLocalWorkflows([wf])` *before* the `program.parseAsync()` so the file is also discoverable by `atomic workflow`.

If the user does not specify, **default to Mode 1**. Confirm in one short question only when the wording is ambiguous (e.g. user says "a workflow I can reuse across projects" — that's a global Mode 1, not project-local).

## Why this recipe exists

Bootstrapping is the highest-friction moment of the SDK because three of the runtime dependencies live outside `bun add`:

- **Bun** — the SDK uses `Bun.spawn` and Bun-specific module resolution. It will not run on Node.
- **A terminal multiplexer** — tmux on macOS/Linux, psmux on Windows. Every `ctx.stage()` runs inside a detachable session on the `atomic` socket.
- **An authenticated agent CLI** — `claude`, `copilot`, or `opencode`. The runtime spawns these at each stage; if the binary is missing or unauthenticated, the first stage will fail with an error the user has no way to interpret.

A user hitting `bun add @bastani/atomic-sdk` in an empty project and then running their workflow will see one of these three blow up 30 seconds in with a stack trace that does not name the missing piece. This recipe checks all three up front and surfaces the missing one as a one-line fix. It also wires the typed errors the SDK throws (`MissingDependencyError`, `SessionNotFoundError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `IncompatibleSDKError`) to actionable messages — so when something does fail later, the user sees a sentence, not a stack.

Treat the steps below as a checklist, not a script. Read each step before running anything; tell the user what you found and what you're about to do; only proceed when each precondition is satisfied. Skipping a step "because it probably works" is what makes setup feel flaky.

## Step 1 — Detect what's already there

Run these in parallel and read the output yourself before relaying anything to the user. If a check fails, stop the recipe and surface the fix before moving on:

```bash
bun --version              # Bun
which tmux || where.exe psmux 2>/dev/null   # multiplexer
claude --version 2>/dev/null               # only one of these matters —
opencode --version 2>/dev/null             # the user picks the agent in step 2
copilot --version 2>/dev/null
ls package.json 2>/dev/null                # is this an existing project?
```

| Missing | Fix to recommend |
|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` (macOS/Linux) or `powershell -c "irm bun.sh/install.ps1 \| iex"` (Windows) |
| tmux/psmux | `brew install tmux` / `apt install tmux` / etc. on macOS+Linux; [psmux](https://github.com/psmux/psmux) on Windows |
| Agent CLI | Direct the user to the agent's install/auth page — Claude Code (`code.claude.com/docs`), OpenCode (`opencode.ai`), Copilot CLI (`github.com/features/copilot/cli`) |

Do not attempt the install yourself unless the user has explicitly approved it — `curl | bash` is a remote-exec that warrants confirmation. Print the suggested command and let the user kick it off.

If the user is on a devcontainer with `ghcr.io/flora131/atomic/<agent>:1` in `.devcontainer/devcontainer.json`, all three are already installed and authenticated — skip the prereq checks and tell them so.

## Step 2 — Pick the agent (and confirm intent)

Ask the user which agent they're targeting and whether they want one or multiple. The answer drives steps 4 and 5.

- **One agent** → scaffold one `<agent>.ts` workflow file + one `<agent>-worker.ts` composition root. This is the 90% case; recommend it unless the user pushes back.
- **Multiple agents, same workflow logic** → scaffold one workflow file per agent under `src/workflows/<name>/` plus a single `src/cli.ts` that uses `createRegistry()` to dispatch.
- **Multiple workflows, one agent** → scaffold each workflow under `src/workflows/<name>/` and either ship multiple worker files or use the registry pattern.

Don't guess. Use `AskUserQuestion` (or the equivalent) when intent is unclear — picking wrong here means rewriting 100% of the scaffold.

## Step 3 — Scaffold via `bun create`

The `bun create @bastani/atomic-cli` scaffold produces the correct project layout for either mode in a single command. It writes the `package.json` with the right deps, the `tsconfig.json`, the starter workflow file, and (for Mode 1) the merged `settings.json` entry. Use it instead of running `mkdir + bun init + bun add` and editing `settings.json` by hand — the scaffold gets the args path, the alias key, and the `agents` array shape right every time, which is where most "broken entry on `atomic workflow refresh`" diagnostics come from when humans hand-write Mode 1.

**Mode 1 — atomic-managed workflow:**

```bash
# Project-scoped (default) — writes to <cwd>/.atomic/workflows/<name>/
# and merges <cwd>/.atomic/settings.json
bun create @bastani/atomic-cli <name> -y \
  --template=atomic-workflow --scope=project --agent=<claude|copilot|opencode>

# Global — writes to ~/.atomic/workflows/<name>/
# and merges ~/.atomic/settings.json (absolute args path so cwd doesn't matter)
bun create @bastani/atomic-cli <name> -y \
  --template=atomic-workflow --scope=global --agent=<claude|copilot|opencode>
```

**Mode 2 — dev-owned CLI:**

```bash
# Writes <cwd>/<name>/ with a Commander tree (mycli.ts), the workflow under
# workflows/hello.ts, a `bun build --compile` script, and the deps wired up.
bun create @bastani/atomic-cli <name> -y \
  --template=standalone-cli --agent=<claude|copilot|opencode>
```

Drop the `-y` if you want the interactive prompts (the scaffold defaults to project-scope + Claude). Run `bun install` inside the generated directory afterward to materialise `node_modules`.

The atomic CLI spawns Mode 1 packages as subprocesses (via `bunx <path>`) — keeping their deps isolated means the host project's deps never collide with the workflow's, and global workflows under `~/.atomic/workflows/<name>/` work identically because they ship their own. The scaffold preserves this isolation: each generated `.atomic/workflows/<name>/` is its own Bun package.

**The scaffold refuses to overwrite an existing alias.** If the user already has a `<name>` workflow registered, the scaffold throws — pick a different name or remove the existing entry first.

**If `bun create` is unavailable** (sandbox without network, integrating with an existing build pipeline that owns `package.json`), the long-form manual playbook is the bottom of this file: §"Manual Mode 1 setup (no `bun create`)" and §"Manual Mode 2 setup (no `bun create`)". The file shapes are identical, you just produce them by hand.

If the user has `npm install`, `yarn add`, or any non-Bun command on file, gently redirect — the SDK will not work under Node, full stop.

## Step 4 — Edit the generated workflow body

The scaffold ships a starter `index.ts` (Mode 1) or `workflows/hello.ts` (Mode 2) shaped like the templates below. The model's job here is to fill in the `.run(async (ctx) => {...})` body with the real pipeline — `ctx.stage()` calls, control flow, data handoffs. The surrounding boilerplate (`#!/usr/bin/env bun` shebang, `defineWorkflow`, `.for`, `.compile`, and the trailing `hostLocalWorkflows` for Mode 1) is what the runtime depends on; leave it in place.

**Why `source: import.meta.path` matters.** The orchestrator re-imports this file from the captured path inside its child process. The scaffold sets it correctly; if you ever rewrite the file from scratch, never drop this field — the workflow loads fine but `runWorkflow` blows up at spawn time with `InvalidWorkflowError`.

**Why the trailing `await hostLocalWorkflows([wf])` matters (Mode 1 only).** It's how the file responds to atomic's two token-gated sub-commands (`_emit-workflow-meta` and `_atomic-run`). Without it, the loader times out and `atomic workflow refresh` surfaces a `BROKEN` entry. Keep it the *last* statement in the file.

### Step 4-Mode1 — What the scaffold writes at `.atomic/workflows/<name>/index.ts`

```ts
#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

const workflow = defineWorkflow({
  name: "<workflow-name>",
  source: import.meta.path,
  description: "<one-line description>",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "what the user supplies" },
  ],
})
  .for("claude") // matches the --agent flag passed to `bun create`
  .run(async (ctx) => {
    await ctx.stage({ name: "main" }, {}, {}, async (s) => {
      await s.session.query(ctx.inputs.prompt);
      s.save(s.sessionId);
    });
  })
  .compile();

await hostLocalWorkflows([workflow]);
```

Replace the single-stage `.run` body with whatever pipeline the user asked for — see SKILL.md §"How Workflows Work" for `ctx.stage()` patterns and §"Concept-to-Code Mapping" for sequential / parallel / loop / headless shapes. For Copilot / OpenCode session bodies, the surrounding `defineWorkflow` shape is identical; only the inner SDK call differs (templates below).

### Step 4-Mode2 — What the scaffold writes at `<name>/workflows/hello.ts`

```ts
import { defineWorkflow } from "@bastani/atomic-sdk";

export default defineWorkflow({
  name: "hello",
  source: import.meta.path,
  description: "Open a single agent session and ask it something.",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "what to ask the agent" },
  ],
})
  .for("claude") // matches the --agent flag passed to `bun create`
  .run(async (ctx) => {
    await ctx.stage({ name: "ask" }, {}, {}, async (s) => {
      await s.session.query(ctx.inputs.prompt);
      s.save(s.sessionId);
    });
  })
  .compile();
```

Mode 2 typically wants one file per agent under `workflows/<name>/<agent>.ts` and one composition root in `mycli.ts`. The scaffold ships the single-agent single-workflow case; for cross-agent support, rename `workflows/hello.ts` → `workflows/<name>/<agent>.ts`, drop sibling files for the other agents, and add subcommands in `mycli.ts`.

#### Claude template

```ts
// src/workflows/<name>/claude.ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "<workflow-name>",
  source: import.meta.path,
  description: "<one-line description>",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "what the user supplies" },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage({ name: "step-1" }, {}, {}, async (s) => {
      await s.session.query(ctx.inputs.prompt ?? "");
      s.save(s.sessionId);
    });
  })
  .compile();
```

#### Copilot template

```ts
.for("copilot")
.run(async (ctx) => {
  await ctx.stage({ name: "step-1" }, {}, {}, async (s) => {
    await s.session.send({ prompt: ctx.inputs.prompt ?? "" });
    s.save(await s.session.getMessages());
  });
})
.compile();
```

#### OpenCode template

```ts
.for("opencode")
.run(async (ctx) => {
  await ctx.stage({ name: "step-1" }, {}, { title: "step-1" }, async (s) => {
    const result = await s.client.session.prompt({
      sessionID: s.session.id,
      parts: [{ type: "text", text: ctx.inputs.prompt ?? "" }],
    });
    s.save(result.data!);
  });
})
.compile();
```

The `s.save(...)` call shape differs per agent on purpose — see `getting-started.md` "Saving Transcripts" for the per-provider rationale.

## Step 5 — Wire the entry point

### Step 5-Mode1 — Refresh and verify

Mode 1 has no separate composition root; the workflow file *is* the entry point because `hostLocalWorkflows([wf])` doubles as the host-dispatch handler. The `bun create` scaffold (Step 3) already wrote the matching `settings.json` entry — project-local at `.atomic/settings.json` or global at `~/.atomic/settings.json` — under the `workflows` key. The scaffold preserves any other entries already in the file; you only need to verify, not re-register.

For reference, the entry the scaffold wrote looks like this (project-scoped):

```jsonc
// .atomic/settings.json
{
  "$schema": "https://raw.githubusercontent.com/flora131/atomic/main/assets/settings.schema.json",
  "version": 1,
  "workflows": {
    "<workflow-name>": {
      "command": "bunx",
      "args": ["./.atomic/workflows/<workflow-name>/index.ts"],
      "agents": ["<agent>"]
    }
  }
}
```

Global-scoped entries use an absolute path in `args` (e.g. `/Users/me/.atomic/workflows/<name>/index.ts`) so `cwd` doesn't change resolution.

Verify the registration:

```bash
atomic workflow refresh
```

Inside an atomic chat session this auto-defaults to JSON; outside, it prints colourised text. Every diagnostic field is on its own `key · value` line so the model can self-correct without prose parsing:

- `loaded` entries confirm the workflow is invocable as `atomic workflow -n <workflow-name> -a <agent>`.
- `broken` entries spell out `reason · …`, `fix · …`, `settings · <path> (workflows.<alias>)` so you know exactly which file and which JSON path to repair before re-running.

Common Mode-1 broken-entry causes — these all surface from the model's edits to the generated `index.ts`, not from the scaffold's settings.json work, which is mechanical:

| Symptom (`reason` field starts with…)                                 | Fix                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `metadata emission timed out`                                         | Ensure `await hostLocalWorkflows([wf])` is the *last* statement in the file (after `.compile()`).        |
| `expected ATOMIC_WORKFLOW_META line`                                  | The file is not importing `@bastani/atomic-sdk`, OR `hostLocalWorkflows` is never called.               |
| `command "<x>" not found on PATH`                                     | Almost certainly a hand-edited entry — the scaffold writes `bunx` + a path. Restore those if you changed them. |
| `command did not register a workflow for agent "<a>"`                 | The `.for(...)` chain in `index.ts` targets a different agent than `agents` in `settings.json` declares. |
| `failed to parse ATOMIC_WORKFLOW_META JSON`                           | A `console.log` or `process.stdout.write` in the file is racing with the meta line — keep the file output-clean. |

### Step 5-Mode2 — Composition root with Commander

The SDK ships pure primitives, not a CLI wrapper. The user composes them into whatever CLI library they prefer. Default to Commander unless they say otherwise.

#### Single workflow worker

```ts
// src/<agent>-worker.ts
import { Command } from "@commander-js/extra-typings";
import {
  getInputSchema,
  runWorkflow,
  MissingDependencyError,
  SessionNotFoundError,
} from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/<name>/<agent>.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  try {
    await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
  } catch (err) {
    if (err instanceof MissingDependencyError) {
      console.error(`Missing dependency: ${err.dependency}. Install it and rerun.`);
      process.exit(1);
    }
    throw err;
  }
});
await program.parseAsync();
```

The typed-error catch is small but it pays for itself the first time `tmux` is missing — the user gets one actionable line instead of an SDK stack trace. Add more `instanceof` branches as the surface grows (see Step 8).

#### Multi-workflow CLI

When the user picks "multiple workflows, one CLI", swap the worker for a registry-driven composition root:

```ts
// src/cli.ts
import { Command } from "@commander-js/extra-typings";
import {
  createRegistry,
  getInputSchema,
  getName,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic-sdk/workflows";
import flowA from "./workflows/<name-a>/<agent>.ts";
import flowB from "./workflows/<name-b>/<agent>.ts";

const registry = createRegistry().register(flowA).register(flowB);
const program = new Command("my-app");
for (const wf of listWorkflows(registry)) {
  const sub = program.command(getName(wf)).description(wf.description);
  for (const input of getInputSchema(wf)) {
    sub.option(`--${input.name} <value>`, input.description ?? "");
  }
  sub.action(async (rawOpts) => {
    await runWorkflow({ workflow: wf, inputs: rawOpts as Record<string, string> });
  });
}
await program.parseAsync();
```

Every `(agent, name)` key must be unique across the registry — registering a duplicate throws immediately at startup, which is intentional. Agents reading the codebase rely on stable keys.

#### Mode 1 + 2 combined

Add `await hostLocalWorkflows([wf])` *before* `program.parseAsync()` in either of the templates above. Atomic's two internal sub-commands are token-gated and `process.exit(0)` after handling, so Commander never sees them on bare invocation. Then ALSO register the file in `settings.json` (Step 5-Mode1) so `atomic workflow -n …` discovers it. The example at <https://github.com/flora131/atomic/tree/main/examples/custom-workflow-bunx> shows the minimal Mode-1 shape; combine its `hostLocalWorkflows([wf])` call with the Commander setup above to get both surfaces in one file.

## Step 6 — Add a `typecheck` script

The biggest payoff for catching mistakes early is `bunx tsc --noEmit`. Wire it into `package.json`:

```jsonc
{
  "scripts": {
    "typecheck": "bunx tsc --noEmit"
  }
}
```

Then run it once before any execution:

```bash
bun run typecheck
```

If this fails, fix the errors before moving on — typecheck failures here usually mean a missing `.compile()`, a mistyped `.for(...)` agent, or an `inputs` field accessed but never declared. All three become silent runtime errors otherwise.

## Step 7 — Smoke test

Run the workflow attached the first time so the user can watch a tmux pane spawn and see Claude/Copilot/OpenCode actually respond.

**Mode 1:**

```bash
atomic workflow refresh                  # confirm registration succeeds
atomic workflow -n <workflow-name> -a <agent> "Reply with the single word 'ok'"
```

If `refresh` reports the workflow as `BROKEN`, fix the issue surfaced in the `fix · …` line *before* trying to invoke — the dispatcher will hard-block with the same diagnostic.

**Mode 2:**

```bash
bun run src/<agent>-worker.ts --prompt "Reply with the single word 'ok'"
```

Three things to verify:

1. **The pane appears** — tmux opens, the agent welcome banner renders, the prompt fires. If the pane never opens, the multiplexer check from Step 1 was wrong.
2. **The agent replies** — within ~30s the agent prints back `ok`. If it sits idle, the agent CLI is probably not authenticated; rerun `claude` / `opencode` / `copilot` and complete the auth flow.
3. **The session ends cleanly** — `s.save(...)` flushes, the orchestrator exits, the user lands back on their shell. If the orchestrator hangs, see `failure-modes.md`.

After the attached run works, demonstrate the detached path:

```bash
bun run src/<agent>-worker.ts --prompt "..." # then in your worker, set detach: true once the user wants it
```

For a worker that supports both, expose `--detach` as a Commander flag and pass `detach: true` to `runWorkflow`. Sessions started detached show up in `atomic session list` (and via `listSessions({ scope: "workflow" })` from your own CLI) — they keep running on the shared `atomic` tmux socket regardless of the terminal.

## Step 8 — Failure recovery (typed errors)

The SDK throws typed errors from `@bastani/atomic-sdk` so callers can pattern-match without parsing message text. When you wire user-facing CLIs, add `instanceof` branches for the ones that need a friendly message:

| Error | When | Friendly message |
|---|---|---|
| `MissingDependencyError` | tmux / psmux / bun is not on `PATH` at runtime | `Missing dependency: <dep>. Install it (see prereqs) and rerun.` |
| `SessionNotFoundError` | `attachSession`/`nextWindow`/`previousWindow`/`gotoOrchestrator` called with an id that's not on the atomic socket | `session not found: <id>. Run "atomic session list" or list via listSessions() to see what's running.` |
| `WorkflowNotCompiledError` | The dev forgot `.compile()` at the end of `defineWorkflow(...)` | The error message itself is the fix — surface as-is. |
| `InvalidWorkflowError` | The imported file's default export isn't a `WorkflowDefinition` | Ditto — surface the message; it tells the dev to add `defineWorkflow(...).compile()`. |
| `IncompatibleSDKError` | The workflow declares `minSDKVersion` newer than the `@bastani/atomic-sdk` version in the project | Tell the user to run `bun update @bastani/atomic-sdk` in the workflow's project or relax the workflow's `minSDKVersion`. Import the class from `@bastani/atomic-sdk/errors` (it's not exported from the `/workflows` barrel). |

Don't catch errors you don't know how to render — let them throw. A blanket `catch (err) { console.error(err) }` defeats the typed surface.

## Step 9 — Hand off

Once the smoke test passes, the user owns the project. Tell them:

- **Where the workflow lives** —
    - Mode 1: `.atomic/workflows/<name>/index.ts` (project) or `~/.atomic/workflows/<name>/index.ts` (global). Edits there change the pipeline shape.
    - Mode 2: `src/workflows/<name>/<agent>.ts`. Edits there change the pipeline shape.
- **Where the entry point lives** —
    - Mode 1: `.atomic/settings.json` (or `~/.atomic/settings.json`). Edits there change which workflows the `atomic` CLI registers — run `atomic workflow refresh` after any settings.json edit to surface broken-entry diagnostics immediately.
    - Mode 2: `src/<agent>-worker.ts` (or `src/cli.ts` for the registry shape). Edits there change the user-facing flag surface.
- **How to monitor** — `atomic session list` for a system-wide view, `atomic workflow status <id>` for one run (returns `awaiting_input` / `needs_review` when a HiL prompt is pending — surface that to the user immediately), or wire `listSessions` / `getSessionStatus` into their own CLI's subcommands. The pane-navigation primitives (`nextWindow`, `previousWindow`, `gotoOrchestrator`, `detachSession`) drive tmux directly without taking over the user's terminal — import them from the **root** `@bastani/atomic-sdk` barrel (not `/workflows`); see [`examples/pane-navigation/`](https://github.com/flora131/atomic/tree/main/examples/pane-navigation) for a reference driver CLI.
- **What to read next** — `references/getting-started.md` for the SDK exports table, `references/control-flow.md` for loops/parallel/headless, `references/state-and-data-flow.md` for `s.save`/`s.transcript` patterns, `references/running-workflows.md` for HiL handling and teardown, `references/failure-modes.md` before shipping any multi-stage workflow.

If the user is now stuck on workflow design rather than setup ("how do I do a review-fix loop?", "what's the right shape for parallel research?"), pivot to the authoring guidance in `SKILL.md` §"Authoring Process" and the `Design Advisory Skills` table. Setup is done.

---

## Manual Mode 1 setup (no `bun create`)

Use this fallback only if `bun create @bastani/atomic-cli` is unavailable — typically a sandbox without network access for `bunx` or an existing build pipeline that owns `package.json`. The scaffold is the recommended path because it gets the args path, alias key, and `agents` array shape right every time. If you do this by hand, replicate exactly the same files the scaffold would write.

```bash
mkdir -p .atomic/workflows/<name>
cd .atomic/workflows/<name>
bun init -y
bun add @bastani/atomic-sdk
bun add @anthropic-ai/claude-agent-sdk     # only if Claude
bun add @github/copilot-sdk                # only if Copilot
bun add @opencode-ai/sdk                   # only if OpenCode
```

Write `index.ts` from the Step 4-Mode1 template above. Then merge an entry into `.atomic/settings.json` (project) or `~/.atomic/settings.json` (global) under the `workflows` key — same shape the scaffold writes (Step 5-Mode1 reference). If `settings.json` exists, *merge*, do not overwrite — `Read` first, then `Edit` the JSON in place to preserve `scm`, `providers`, and any other workflow aliases.

## Manual Mode 2 setup (no `bun create`)

```bash
bun init -y                                # skip if package.json exists
bun add @bastani/atomic-sdk
bun add @anthropic-ai/claude-agent-sdk     # only if Claude
bun add @github/copilot-sdk                # only if Copilot
bun add @opencode-ai/sdk                   # only if OpenCode
bun add @commander-js/extra-typings        # for the worker; swap for citty/yargs if the user prefers
```

Write `src/workflows/<name>/<agent>.ts` from the Step 4-Mode2 template above and the composition root from the Step 5-Mode2 templates. The standalone-cli template the scaffold ships also writes a `build.ts` for `bun build --compile` — replicate it from [`examples/compiled-cli/build.ts`](https://github.com/flora131/atomic/tree/main/examples/compiled-cli) if you want single-binary distribution.
