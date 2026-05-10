# Agent Setup Recipe

A deterministic recipe for getting a user from "empty terminal" to "first workflow runs" in one session. This is the path to follow whenever the user signals they want to start using the workflow SDK from zero — phrases like *"set me up with the workflow SDK"*, *"I want to write workflows"*, *"bootstrap a workflow project"*, *"how do I get started"*, or any equivalent. If the user already has `@bastani/atomic-sdk` installed and a workflow file exists, jump to step 5.

## Pick the mode first (see SKILL.md §"Custom workflow modes")

Two distinct setup tracks share Steps 1–3, then branch at Step 4:

- **Mode 1 — Atomic-managed.** The default. Workflow lives in `.atomic/workflows/<name>/` (project) or `~/.atomic/workflows/<name>/` (global) as a self-contained Bun package, registered in `settings.json`, invoked via `atomic workflow -n <name>`. Branch to **Step 4-Mode1** and **Step 5-Mode1**.
- **Mode 2 — Dev-owned CLI.** Workflow lives in `<repo>/src/workflows/<name>/<agent>.ts` with a Commander composition root in `<repo>/src/<agent>-worker.ts`. Branch to **Step 4-Mode2** and **Step 5-Mode2**.

If the user does not specify, **default to Mode 1**. Confirm in one short question only when the wording is ambiguous (e.g. user says "a workflow I can reuse across projects" — that's a global Mode 1, not project-local).

## Why this recipe exists

Bootstrapping is the highest-friction moment of the SDK because two of the runtime dependencies live outside `bun add`:

- **Bun** — the SDK uses `Bun.spawn` and Bun-specific module resolution. It will not run on Node.
- **An authenticated agent CLI** — `claude`, `copilot`, or `opencode`. The daemon spawns these as PTY-attached subprocesses at each stage; if the binary is missing or unauthenticated, the first stage will fail with `MissingDependencyError` and the user has no way to interpret the error without context.

**No terminal multiplexer required.** Atomic 2.0's daemon owns all process supervision via `bun-pty` allocators. There is no tmux or psmux dependency.

**The daemon.** `atomic --ui-server` is a per-user singleton daemon. The SDK auto-spawns it on first `runWorkflow({...})` call and auto-discovers it via `~/.atomic/daemon.endpoint.json`. The daemon supervises every agent subprocess, maintains all panel state, and exposes a JSON-RPC 2.0 control surface. Workflow authors do not interact with the daemon directly — `runWorkflow` handles discovery and dispatch transparently.

A user hitting `bun add @bastani/atomic-sdk` in an empty project and then running their workflow will see one of the missing deps blow up 30 seconds in with a stack trace that does not name the missing piece. This recipe checks them up front and surfaces the missing one as a one-line fix. It also wires the typed errors the SDK throws (`MissingDependencyError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `IncompatibleSDKError`) to actionable messages — so when something does fail later, the user sees a sentence, not a stack.

Treat the steps below as a checklist, not a script. Read each step before running anything; tell the user what you found and what you're about to do; only proceed when each precondition is satisfied. Skipping a step "because it probably works" is what makes setup feel flaky.

## Step 1 — Detect what's already there

Run these in parallel and read the output yourself before relaying anything to the user. If a check fails, stop the recipe and surface the fix before moving on:

```bash
bun --version              # Bun
claude --version 2>/dev/null               # only one of these matters —
opencode --version 2>/dev/null             # the user picks the agent in step 2
copilot --version 2>/dev/null
ls package.json 2>/dev/null                # is this an existing project?
```

| Missing | Fix to recommend |
|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` (macOS/Linux) or `powershell -c "irm bun.sh/install.ps1 \| iex"` (Windows) |
| Agent CLI | Direct the user to the agent's install/auth page — Claude Code (`code.claude.com/docs`), OpenCode (`opencode.ai`), Copilot CLI (`github.com/features/copilot/cli`) |

Do not attempt the install yourself unless the user has explicitly approved it — `curl | bash` is a remote-exec that warrants confirmation. Print the suggested command and let the user kick it off.

If the user is on a devcontainer with `ghcr.io/flora131/atomic/<agent>:1` in `.devcontainer/devcontainer.json`, all prereqs are already installed and authenticated — skip the prereq checks and tell them so.

**Note on the daemon binary.** `@bastani/atomic-sdk` declares every platform variant of `@bastani/atomic` as an `optionalDependency`, so `bun add @bastani/atomic-sdk` auto-installs the daemon binary for the current platform. No separate install step is needed unless the user is in a stripped environment (e.g. Docker layer with only `--production` deps).

## Step 2 — Pick the agent (and confirm intent)

Ask the user which agent they're targeting and whether they want one or multiple. The answer drives steps 4 and 5.

- **One agent** → scaffold one `<agent>.ts` workflow file + one `<agent>-worker.ts` composition root. This is the 90% case; recommend it unless the user pushes back.
- **Multiple agents, same workflow logic** → scaffold one workflow file per agent under `src/workflows/<name>/` plus a single `src/cli.ts` that uses `createRegistry()` to dispatch.
- **Multiple workflows, one agent** → scaffold each workflow under `src/workflows/<name>/` and either ship multiple worker files or use the registry pattern.

Don't guess. Use `AskUserQuestion` (or the equivalent) when intent is unclear — picking wrong here means rewriting 100% of the scaffold.

## Step 3 — Bootstrap the package

For **Mode 1**, the package lives at `.atomic/workflows/<name>/` (or `~/.atomic/workflows/<name>/` for global) and is fully self-contained — its own `package.json`, `tsconfig.json`, and `node_modules`. Do this *inside* that directory, not in the repo root:

```bash
mkdir -p .atomic/workflows/<name>
cd .atomic/workflows/<name>
bun init -y
bun add @bastani/atomic-sdk
bun add @anthropic-ai/claude-agent-sdk     # only if Claude
bun add @github/copilot-sdk                # only if Copilot
bun add @opencode-ai/sdk                   # only if OpenCode
```

The daemon imports this package when dispatching — keeping its dependencies isolated means the host project's deps never collide with the workflow's, and global workflows under `~/.atomic/workflows/<name>/` work identically because they ship their own deps.

For **Mode 2**, work in the repo root:

```bash
bun init -y                                # skip if package.json exists
bun add @bastani/atomic-sdk
bun add @anthropic-ai/claude-agent-sdk     # only if Claude
bun add @github/copilot-sdk                # only if Copilot
bun add @opencode-ai/sdk                   # only if OpenCode
bun add @commander-js/extra-typings        # for the worker; swap for citty/yargs if the user prefers
```

If the user has `npm install`, `yarn add`, or any non-Bun command on file, gently redirect — the SDK will not work under Node, full stop.

## Step 4 — Scaffold the workflow file

Always include `source: import.meta.path` — the daemon re-imports the module from this path when executing the workflow. Forget it and the workflow loads fine but `workflow/start` fails with `InvalidWorkflowError` at dispatch time.

Workflow files use `export default workflow` — **not** `hostLocalWorkflows([workflow])`. That call is removed in atomic 2.0; the daemon's import-based dispatch replaces it.

### Step 4-Mode1 — Atomic-managed entry (`.atomic/workflows/<name>/index.ts`)

Single file per workflow package. Add an executable shebang so the file can be invoked via `bunx <path>`.

```ts
// .atomic/workflows/<name>/index.ts
#!/usr/bin/env bun
import { defineWorkflow } from "@bastani/atomic-sdk";

const workflow = defineWorkflow({
  name: "<workflow-name>",
  source: import.meta.path,
  description: "<one-line description>",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "what the user supplies" },
  ],
})
  .for("claude") // or .for("copilot") / .for("opencode") — pick the agent the user named
  .run(async (ctx) => {
    await ctx.stage({ name: "step-1" }, {}, {}, async (s) => {
      await s.session.query(ctx.inputs.prompt);
      s.save(s.sessionId);
    });
  })
  .compile();

export default workflow;
```

For Copilot / OpenCode session bodies, use the same `.for(...)` + `.run(...)` shape as Mode 2 templates below — only the directory layout and package boundary change between modes.

### Step 4-Mode2 — Dev-owned files (`src/workflows/<name>/<agent>.ts`)

Drop into `src/workflows/<name>/<agent>.ts`. The convention is one directory per workflow, one file per agent — this keeps `src/workflows/<name>/helpers/` available for SDK-agnostic logic when the user does want cross-agent support later. The naming matters because every reference doc and every agent looking at the codebase finds files the same way.

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

## How the daemon runs agent CLIs

Understanding this prevents the most common failure modes:

**Each `ctx.stage(...)` callback causes the daemon to spawn the agent CLI as a PTY subprocess.** The daemon's process supervisor allocates a PTY via `bun-pty`, spawns (e.g.) `claude`, `copilot`, or `opencode` as a child process of the daemon, and routes the PTY's output to subscribed panel clients via `pane/output` notifications.

- The agent binary must be on `PATH` when the daemon starts. If it's missing, the daemon sends a `MISSING_DEPENDENCY` error (code `-32008`) and the SDK throws `MissingDependencyError` with `data: { dependency: "<agent-binary>" }`.
- Agent CLIs are authenticated separately from atomic. Run `claude`, `opencode`, or `copilot` interactively once to complete their auth flows before running a workflow.
- Each stage's PTY scrollback is held in the daemon's memory (default 4 MiB per stage) and accessible to panel clients via `pane/getScrollback`. Scrollback is also written to `~/.atomic/sessions/<runId>/<stageName>-<stageId>/` on disk.
- When a panel client attaches with `atomic workflow attach <runId>`, it calls `panel/subscribe` + `pane/getScrollback` to reconstruct current state. Multi-attach works: N clients can subscribe simultaneously.
- Keystrokes typed in the panel are forwarded to the daemon via `pane/sendInput`, which writes to the PTY. This is how HIL prompts reach the agent.

**The `MissingDependencyError` pattern.** Surface it clearly:

```ts
import { MissingDependencyError } from "@bastani/atomic-sdk";

try {
  await runWorkflow({ workflow, inputs });
} catch (err) {
  if (err instanceof MissingDependencyError) {
    console.error(
      `Missing dependency: ${err.dependency}. Install it and ensure it is on PATH, then rerun.`
    );
    process.exit(1);
  }
  throw err;
}
```

The `err.dependency` field names the exact missing binary (e.g. `"claude"`, `"copilot"`, `"opencode"`, `"@bastani/atomic"`). Show it verbatim — it's the actionable fix.

## Step 5 — Wire the entry point

### Step 5-Mode1 — Register in `settings.json` and refresh

Mode 1 has no separate composition root. Register the package in atomic's settings file:

- **Project-local** → `.atomic/settings.json` (recommended default)
- **Global** → `~/.atomic/settings.json` (use absolute paths in `args` so `cwd` doesn't matter)

```jsonc
// .atomic/settings.json
{
  "$schema": "https://raw.githubusercontent.com/flora131/atomic/main/assets/settings.schema.json",
  "version": 1,
  "workflows": {
    "<workflow-name>": {
      "command": "bunx",
      "args": ["./.atomic/workflows/<workflow-name>/index.ts"],
      "agents": ["claude"]
    }
  }
}
```

If the user already has a `settings.json`, *merge* into the existing `workflows` object — do not overwrite it. Use `Read` first, then `Edit` the JSON in place.

Then verify the registration:

```bash
atomic workflow refresh
```

The daemon re-imports each registered workflow file. Inside an atomic chat session this auto-defaults to JSON; outside, it prints colourised text. Every diagnostic field is on its own `key · value` line so the model can self-correct without prose parsing:

- `loaded` entries confirm the workflow is invocable as `atomic workflow -n <workflow-name> -a <agent>`.
- `broken` entries spell out `reason · …`, `fix · …`, `settings · <path> (workflows.<alias>)` so you know exactly which file and which JSON path to repair before re-running.

Common Mode-1 broken-entry causes the model should self-diagnose:

| Symptom (`reason` field starts with…)                                 | Fix                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `export default is not a WorkflowDefinition`                          | The file doesn't end with `.compile()`, or exports something other than the compiled definition.        |
| `source field missing or does not match import.meta.path`             | Add `source: import.meta.path` to `defineWorkflow({...})`.                                              |
| `command "<x>" not found on PATH`                                     | Use `bunx` + a path under `args`, not a bare command — or supply an absolute path.                      |
| `command did not register a workflow for agent "<a>"`                 | The `.for(...)` chain targets a different agent than `agents` in `settings.json` declares.              |
| `import error: <message>`                                             | TypeScript or module resolution error in the workflow file — fix the TS error and re-run refresh.       |

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
} from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/<name>/<agent>.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  try {
    const { runId } = await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
    console.log(`Started: ${runId}`);
    console.log(`Attach:  atomic workflow attach ${runId}`);
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

The typed-error catch is small but it pays for itself the first time an agent CLI is missing — the user gets one actionable line instead of an SDK stack trace. Add more `instanceof` branches as the surface grows (see Step 8).

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
    const { runId } = await runWorkflow({ workflow: wf, inputs: rawOpts as Record<string, string> });
    console.log(`Started: ${runId}`);
    console.log(`Attach:  atomic workflow attach ${runId}`);
  });
}
await program.parseAsync();
```

Every `(agent, name)` key must be unique across the registry — registering a duplicate throws immediately at startup, which is intentional. Agents reading the codebase rely on stable keys.

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

Run the workflow the first time so the user can watch the OpenTUI panel appear and see Claude/Copilot/OpenCode actually respond.

**Mode 1:**

```bash
atomic workflow refresh                  # confirm registration succeeds
atomic workflow -n <workflow-name> -a <agent> "Reply with the single word 'ok'"
# in a second terminal: atomic workflow attach <runId printed above>
```

If `refresh` reports the workflow as `BROKEN`, fix the issue surfaced in the `fix · …` line *before* trying to invoke — the dispatcher will hard-block with the same diagnostic.

**Mode 2:**

```bash
bun run src/<agent>-worker.ts --prompt "Reply with the single word 'ok'"
# in a second terminal: atomic workflow attach <runId printed above>
```

Three things to verify:

1. **The panel appears** — `atomic workflow attach <runId>` opens an OpenTUI panel client showing the workflow graph. The stage's PTY pane renders the agent's welcome banner and the prompt fires. If the panel never shows stage output, check that the agent CLI is on `PATH` from the daemon's environment.
2. **The agent replies** — within ~30s the agent prints back `ok` in the PTY pane. If it sits idle, the agent CLI is probably not authenticated; run `claude` / `opencode` / `copilot` interactively and complete the auth flow, then restart the daemon (`atomic --ui-server`).
3. **The run ends cleanly** — `s.save(...)` flushes, the daemon marks the run `completed`, and the panel's status updates. If the run hangs, see `failure-modes.md`.

After the attached run works, demonstrate the detached path:

```bash
bun run src/<agent>-worker.ts --prompt "..." --detach
# or pass detach: true to runWorkflow in the worker
# then: atomic workflow status <runId>  (poll)
# then: atomic workflow attach <runId>  (when you want to watch)
```

Runs started detached show up in `atomic workflow status` (all runs) and continue in the daemon regardless of whether a panel client is attached.

## Step 8 — Failure recovery (typed errors)

The SDK throws typed errors from `@bastani/atomic-sdk` so callers can pattern-match without parsing message text. When you wire user-facing CLIs, add `instanceof` branches for the ones that need a friendly message:

| Error | When | Friendly message |
|---|---|---|
| `MissingDependencyError` | The agent CLI binary (`claude`, `copilot`, `opencode`) or the `@bastani/atomic` daemon binary is not on `PATH` at runtime | `Missing dependency: ${err.dependency}. Install it, ensure it is on PATH, and rerun.` |
| `WorkflowNotCompiledError` | The dev forgot `.compile()` at the end of `defineWorkflow(...)` | The error message itself is the fix — surface as-is. |
| `InvalidWorkflowError` | The imported file's default export isn't a `WorkflowDefinition` | Ditto — surface the message; it tells the dev to add `defineWorkflow(...).compile()` and `export default workflow`. |
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
- **How to monitor** — `atomic workflow status` for all runs, `atomic workflow status <runId>` for one run (returns `awaiting_input` / `needs_review` when a HIL prompt is pending — surface that to the user immediately), `atomic workflow attach <runId>` to open a panel client. The daemon broadcasts `panel/update` to all subscribers; multi-attach works out of the box.
- **How to send input to a paused stage** — `atomic workflow attach <runId>` opens the panel; keystrokes are forwarded to the active stage's PTY via `pane/sendInput`. There is no CLI shortcut for non-interactive input forwarding.
- **What to read next** — `references/getting-started.md` for the SDK exports table, `references/control-flow.md` for loops/parallel/headless, `references/state-and-data-flow.md` for `s.save`/`s.transcript` patterns, `references/running-workflows.md` for HIL handling and teardown, `references/failure-modes.md` before shipping any multi-stage workflow.

If the user is now stuck on workflow design rather than setup ("how do I do a review-fix loop?", "what's the right shape for parallel research?"), pivot to the authoring guidance in `SKILL.md` §"Authoring Process" and the `Design Advisory Skills` table. Setup is done.
