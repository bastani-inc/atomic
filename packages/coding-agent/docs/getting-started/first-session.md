---
title: First session
description: Start Atomic, run a first task, invoke a built-in workflow, and steer a run.
---

# First session

**Outcome:** You complete one interactive task and know how to monitor and steer it.

**Prerequisites:** [Authentication](/getting-started/authentication) is complete.

## First session

On a fresh install with no prior Atomic startup state, Atomic shows a one-time first-run explanation after any What's New notes and directly above the input box describing Atomic as a verifiable coding agent runtime for building and running agent workflows you can feel confident in. Returning users with prior startup state are marked onboarded automatically and continue directly into the normal chat UI; stored credentials by themselves do not skip the first-run explanation. The composer is the normal Atomic input from the start: type a message, run `/login` first if no provider is connected, or launch a workflow command without a special onboarding transition.

Once Atomic starts, default to a workflow for non-trivial work and for requests with inherent structure plus a verifiable objective. Implementation, build, debugging, bug fixes, migrations, features, scoped multi-file edits, validation/review work, and loop-shaped requests are workflow candidates; reserve direct chat for tiny deterministic low-risk answers or edits where tracking clearly adds more overhead than value.

Workflow-first is not builtin-only or monolithic. Atomic can discover and run named builtin, project, user, and package workflows; author a rich custom TypeScript `workflow({...})` inline; and compositionally import reusable workflow definitions—including builtins from `@bastani/atomic/workflows/builtin`—into parent workflows with `ctx.workflow(...)`. Nested children can nest again within `maxDepth`, so custom graphs can combine proven research, implementation, design, verification, and approval workflows instead of copying them. They can also classify and branch, dynamically fan out and synthesize artifacts, run adversarial repair cycles, tournament-rank candidates, and loop until checks pass with explicit bounds.

Atomic turns repeatable engineering loops into executable stages with inspectable evidence instead of relying on a markdown checklist the model may or may not follow.

## Verify the session

Run one bounded task and watch it complete. In a repository you know, type:

```text
List the top-level directories in this repository and say what each one holds.
```

Expected result: Atomic streams a response, calls `read` on a directory, `find`, or `bash` at least once — each tool call is shown inline as it runs — and finishes with a summary naming directories that actually exist in your checkout. A response that names nothing from your repository means the session started outside the directory you meant; quit, `cd` to the right place, and start Atomic again.

Then confirm the session was recorded:

```bash
atomic -r
```

Expected result: the session picker lists the run you just finished. That session is what `atomic -c` resumes.

## Go further

With a session working, these are the fuller capabilities to reach for next. None of them is required for a first successful session.

### Try the built-in workflows

Atomic ships with nine workflows you can run immediately. Use `/workflow list` to see them and `/workflow inputs <name>` to inspect their inputs in your environment.

| Workflow | When to use | Example |
|---|---|---|
| `classify-and-act` | Route requests through structured classification and low-confidence human fallback. | `/workflow classify-and-act prompt="Triage and handle this request"` |
| `fan-out-and-synthesize` | Partition independent slices, including repository-focused research, and synthesize their artifact evidence. | `/workflow fan-out-and-synthesize prompt="Map payment retries by subsystem and synthesize cited findings"` |
| `adversarial-verification` | Challenge a candidate with fresh verifiers and bounded repair. | `/workflow adversarial-verification task="Verify the migration patch"` |
| `generate-and-filter` | Generate, dedupe, filter, optionally judge, and shortlist candidates. | `/workflow generate-and-filter prompt="Propose names for the new command"` |
| `tournament` | Compare whole solutions through balanced pairwise judging. | `/workflow tournament prompt="Design the retry strategy"` |
| `loop-until-done` | Iterate with a durable ledger until completion or bound exhaustion. | `/workflow loop-until-done prompt="Repair failures until the test suite passes"` |
| `goal` | Autonomous work that needs a durable ledger, bounded sub-agent orchestration, receipts, and reviewer-gated completion. | `/workflow goal objective="Update the CLI docs, add one example, and validate the docs build"` |
| `ralph` | Research-first autonomous work with prompt refinement, delegated implementation, and iterative multi-model review. | `/workflow ralph prompt="Implement specs/rate-limit.md and validate burst traffic"` |
| `open-claude-design` | UI and design-system work with one generated preview, one live review session, and export. | `/workflow open-claude-design prompt="Refresh the settings page hierarchy as a page"` |

<p align="center"><img src="../images/workflow-list.png" alt="Workflow List" width="600" /></p>

Inputs are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=5`, `flag=true`, and `prompt="multi word value"` preserve useful types. If you call `/workflow <name>` without required inputs, the TUI opens an inline picker; pass `--no-picker` to skip it. Goal and Ralph support `git_worktree_dir` only when you explicitly want a reusable worktree, and skip PR creation unless you set `create_pr=true` for the post-approval final stage.

You can also launch workflows with **natural language** — describe the task in chat and ask Atomic to run a matching installed workflow or author a task-specific one:

```text
Fan out repository research by subsystem, save cited findings as artifacts, and synthesize the evidence.
```

```text
Create a worker → fresh verifier → reducer workflow that updates the CLI docs, runs the docs build, and repairs evidence-backed findings until it passes or reaches a bounded stop.
```

```text
Use goal to update the CLI docs, include one example, run the docs build, and finish only when reviewers approve the evidence.
```

```text
Use ralph to research and implement specs/rate-limit.md, then review and repair it within three loops.
```

Atomic chooses a complete execution shape, fills inputs from the request, and confirms before launch. Use Goal when a durable ledger and receipt-backed reviewer gate fit the task. Use Ralph when the job benefits from a research-first implementation/review loop. For exact domain contracts that either builtin does not cover, author a custom graph with deterministic checks and bounded repairs.

### Monitor and steer a run

Named workflow runs execute in the background. After launch you get the full 36-character run UUID shown by user-facing workflow surfaces. Every workflow command and action requires that full displayed ID; prefixes and 32-character dashless forms are rejected rather than resolved.

```text
/workflow status <full-run-id>         # inspect one run's progress
/workflow status                       # list this session's active and terminal runs
/workflow connect <full-run-id>        # see agents working; chat with or steer each stage (F2 also opens latest)
/workflow attach <full-run-id> <stage> # chat with one stage
/workflow pause <full-run-id>          # pause resumably
/workflow resume <full-run-id> "go"    # send a steer message and resume
/workflow quit <full-run-id>           # pause gracefully and keep the run resumable
```

At 80 columns and wider, each ordinary `BACKGROUND` card shows the full run ID plus workflow metadata. When its visible run tree has exactly one displayable human-in-the-loop request, the card adds one bounded, terminal-control-stripped question row and `Answer: /workflow connect <full-run-id>`, with the full ID wrapping rather than being cut. F2 still opens the active workflow, but is not repeated in the answer hint. Promptless, multiple, ambiguous, and custom-only waits remain status-only. The header retains its generic ``(attach to workflow with `/workflow connect`)`` guidance whenever any workflow needing attention lacks its own answer command; otherwise it shows only the attention count and glyphs. Below 80 columns the panel remains count-only, while full IDs in chat surfaces wrap rather than being cut.

Interactive users answer through F2 or the connected workflow; agents use `workflow answer` with the full run ID and exact stage/prompt identity. The live affordance is widget-only, self-clears when the exact prompt resolves, and never enters the transcript or parent-model context.

Atomic posts main-chat lifecycle notices when a run completes or fails, but it does not post awaiting prompts into main chat. If you answer a workflow prompt in the graph or attached stage chat, the main chat receives a display-only answer summary for audit; it does not wake the model, enter LLM context, or answer later prompts. See [Workflow Operations](/workflows/operations) for the full run-control reference.

### Top skills to invoke directly

Skills are reusable expert instructions. Trigger one with `/skill:<name>` followed by a request:

| Skill | When to use | Example |
|---|---|---|
| `research-codebase` | Scoped research that writes a grounded artifact for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Write, evaluate, migrate, or troubleshoot GPT and Claude prompts using separate model guides. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine web/native frontend and product UI; includes detector hooks, framework-aware live review, and mount-failure recovery. | `/skill:impeccable` |
| `playwright-cli` | Drive a real browser for end-to-end UI checks, screenshots, and reviewable proof videos. | `/skill:playwright-cli` |
| `qlty` | Lint, auto-format, and measure code quality — complexity, duplication, and code smells — through one CLI across the repository's languages. | `/skill:qlty check this branch before I hand it off` |
| `liteparse` | Pull text, tables, or values out of PDF, DOCX, PPTX, XLSX, and image files locally. | `/skill:liteparse` |
| `show-me` | Explain a topic visually with concise diagrams, code-shape sketches, or focused HTML artifacts. HumanLayer, MIT licensed. | `/skill:show-me` |

Impeccable 4.1.1 resolves Live sessions to the selected app root, supports SvelteKit, Nuxt, TanStack Start, Astro, Next.js, Vite, and static HTML injection, and rejects absolute, traversing, or symlinked configured write targets. Its concept roll may contact `impeccable.style`; set `IMPECCABLE_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` to disable the anonymous choice ping. The image fallback runs only with `OPENAI_API_KEY`, sends prompts and optional reference images to OpenAI, and spends that account's API credit. Generated image prompts are embedded in the image or a sidecar, so do not include secrets.

Use `/skill:research-codebase` for a focused subsystem or question. For repository-wide research, use `fan-out-and-synthesize` with distinct repository partitions and an artifact synthesis barrier. Use Goal for ledger-backed bounded orchestration and Ralph for research-first delegated implementation with iterative review; task size alone does not select either workflow.

### Create your own workflow in natural language

Named workflows may be builtin, project, user, or package supplied. You do not have to hand-write TypeScript to add a new workflow. Describe what you want in plain chat and Atomic will design and write it for you using [Builtins and Dynamic Workflows](/workflows/builtins) and the [Custom Workflow Authoring](/workflows/authoring) reference as its source of truth:

```text
Create a reusable Atomic workflow called review-changes. It takes one
required text input `target` (a diff, PR, or review focus). Run two reviewers
in parallel with fresh context — one for correctness and missing tests, one
for edge cases and maintainability — then a synthesis stage that
consolidates findings into blockers vs. suggestions and returns
{ consolidated_review, decision }.
```

Atomic will:

- ask clarifying questions if stage purpose, inputs, models, or handoffs are ambiguous,
- write a `.atomic/workflows/<name>.ts` definition that uses `workflow({ ... })` and imports `Type` from `typebox`,
- run `/workflow reload` so the generated workflow is rediscovered and can be launched with `/workflow <name>`,
- then report the generated workflow folder so you can inspect the code it wrote, using `Custom workflow created. You can inspect its code at: <workflow-folder-path>` (for example, `.atomic/workflows/`); Atomic does this only for newly created custom workflows, never builtin or pre-existing workflows.

The same plain-chat approach works for editing or hardening an existing workflow. For the full authoring reference, see [Custom Workflow Authoring](/workflows/authoring), including composition with user-defined workflows and all nine builtins from `@bastani/atomic/workflows/builtin`.

### Default tools and prompts

If you'd rather start with a plain prompt, just type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Atomic gives the model these tools:

- `read` - read files
- `bash` - run shell commands
- `kill` - cancel owned background shell tasks by task ID
- `edit` - patch files
- `write` - create or overwrite files
- `find` - discover files by glob pattern
- `search` - search file contents
- `ask_user_question` - ask structured questions in the TUI
- `todo` - manage file-based todos

On native Windows, `powershell` is also enabled when a PowerShell executable is available.

Normal coding sessions include file discovery and content search through `find` and `search` in addition to `read`, `bash`, `edit`, and `write`. Atomic runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Next step

Continue to [Project instructions](/getting-started/project-instructions).
