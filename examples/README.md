# Examples

Reference patterns for atomic-powered workflows and CLIs. Each directory
demonstrates **one** specific SDK feature or distribution shape.

## Starting a new project?

Don't copy from these directories — run:

```bash
bun create @bastani/atomic-cli my-app
```

The scaffold prompts for what you're building (a workflow that atomic
dispatches, or your own standalone CLI) and where it lives, then writes
a working project. Once you have one, browse here for patterns to layer
in.

## By distribution shape

| Directory | What you ship |
| --- | --- |
| [`compiled-cli/`](./compiled-cli) | Single binary via `bun build --compile`. Workflows bundled in. (Snapshot of `bun create --template=standalone-cli`.) |
| [`commander-embed/`](./commander-embed) | A workflow under a parent Commander tree, alongside plain Commander commands. |
| [`multi-workflow/`](./multi-workflow) | One CLI exposing multiple workflows via a registry. |
| [`custom-workflow-bunx/`](./custom-workflow-bunx) | A workflow registered in atomic's `settings.json` and dispatched by `atomic workflow ...`. Distributed via `bunx`. |

## By workflow pattern

### Single session

| Directory | Pattern |
| --- | --- |
| [`hello-world/`](./hello-world) | The minimum workflow shape — one stage, structured inputs, runs across all three agents. |

### Multi-stage handoffs

| Directory | Pattern |
| --- | --- |
| [`sequential-describe-summarize/`](./sequential-describe-summarize) | Two stages handing off via `s.save()` + `s.transcript(handle)`. |
| [`review-fix-loop/`](./review-fix-loop) | Bounded `for` loop with early exit on a `CLEAN` verdict. |

### Concurrency

| Directory | Pattern |
| --- | --- |
| [`parallel-hello-world/`](./parallel-hello-world) | `Promise.all()` fan-out across stages + transcript merge. |
| [`headless-test/`](./headless-test) | Mixing visible (tmux pane) and headless stages in one workflow. |
| [`claude-background-subagents/`](./claude-background-subagents) | Background subagents (`run_in_background: true`) with in-flight gating across stage boundaries. |

### Human-in-the-loop

| Directory | Pattern |
| --- | --- |
| [`hil-favorite-color/`](./hil-favorite-color) | Mid-workflow prompt for user input from a visible stage. |
| [`hil-favorite-color-headless/`](./hil-favorite-color-headless) | HIL escalation from an otherwise-headless stage. |

### Agent SDK features

| Directory | Pattern |
| --- | --- |
| [`structured-output-demo/`](./structured-output-demo) | Schema-enforced responses (JSON schema / Zod / `defineTool`) across all three agents. |
| [`reviewer-tool-test/`](./reviewer-tool-test) | Custom Copilot reviewer tool with Zod validation. |

### TUI navigation

| Directory | Pattern |
| --- | --- |
| [`pane-navigation/`](./pane-navigation) | Driving the SDK's pane-navigation primitives (`nextWindow`, `gotoOrchestrator`, etc.) from a host CLI. |

## Conventions

Every example follows the same shape:

- `<agent>/index.ts` — workflow definition for that agent
- `<agent>-worker.ts` — Commander entrypoint that calls `runWorkflow`
- (Or a single `cli.ts` for examples with one Commander tree spanning multiple workflows.)
- `package.json` declares `@bastani/atomic-sdk` plus the agent's SDK as deps.

Each example's README has a "Run" section with the canonical commands
and a "What's here" file map. The agent-specific bits are deliberately
minimal so you can copy a single `<agent>/index.ts` into a fresh
scaffold without dragging the whole example with you.
