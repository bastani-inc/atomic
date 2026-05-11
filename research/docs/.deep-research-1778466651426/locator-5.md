# Partition 5: examples/ — Per-Agent Worker Scripts & DSL Reference

## Overview
The `examples/` directory (14 subdirectories, 80+ files, 3,981 LOC) contains canonical reference implementations for the Atomic CLI workflow DSL. Each example demonstrates a distinct pattern: workflow definition (`defineWorkflow().for().run().compile()`), per-agent variations (claude/copilot/opencode), and CLI entrypoints via Commander worker scripts.

---

## Implementation

### Workflow Definition Patterns

#### Single-Workflow Examples
- `examples/hello-world/claude/index.ts` — Basic `defineWorkflow` + `.for("claude").run().compile()` with structured inputs (string/enum/text), two-turn conversation, and prompt-in-argv delivery
- `examples/hello-world/copilot/index.ts` — Same workflow schema for Copilot SDK (`.send()` instead of `.query()`)
- `examples/hello-world/opencode/index.ts` — OpenCode variant using `s.client.session.prompt()` with permission records
- `examples/parallel-hello-world/claude/index.ts` — Three concurrent stages via `Promise.all()`, transcript merge handoff pattern
- `examples/hil-favorite-color/claude/index.ts` — Human-in-the-loop pause for user input, interactive tmux pane
- `examples/hil-favorite-color-headless/claude/index.ts` — HIL escalation from headless stage to interactive on prompt arrival
- `examples/headless-test/claude/index.ts` — Mixed visible/headless stages (visible seed → 3 parallel headless → visible merge → headless verdict)
- `examples/sequential-describe-summarize/claude/index.ts` — Two-stage handoff via `s.save(sessionId)` → downstream `s.transcript(handle)` to read upstream output
- `examples/review-fix-loop/claude/index.ts` — Bounded loop with early exit: draft → loop(review → fix) on `handle.result` control flow
- `examples/structured-output-demo/claude/index.ts` — Headless structured output via `outputFormat: { type: "json_schema", schema }` in `s.session.query()` options, validation read from `s.session.lastStructuredOutput`
- `examples/structured-output-demo/copilot/index.ts` — Structured output via Copilot's `defineTool` with Zod-validated parameters
- `examples/structured-output-demo/opencode/index.ts` — OpenCode structured via `format: { type: "json_schema", schema }` in `s.client.session.prompt()`, read from `result.data.info.structured`
- `examples/claude-background-subagents/claude/index.ts` — Two-stage workflow with `run_in_background: true` subagents, stage 2 verifies in-flight gating
- `examples/reviewer-tool-test/copilot/index.ts` — Copilot SDK custom `defineTool` wiring (Copilot-only)
- `examples/commander-embed/claude/index.ts` — Embedded workflow under parent Commander CLI via `runWorkflow({ workflow, inputs })`
- `examples/pane-navigation/claude/index.ts` — 3-stage workflow for SDK pane primitives testing (nextWindow, previousWindow, gotoOrchestrator, attachSession, detachSession)

#### Multi-Workflow Example
- `examples/multi-workflow/hello/claude.ts` — Subworkflow for multi-registry pattern, greet-by-name workflow
- `examples/multi-workflow/goodbye/claude.ts` — Second subworkflow in multi-registry (registered via `.register().register()`)

#### Custom Distributed Workflow
- `examples/custom-workflow-bunx/index.ts` — `hostLocalWorkflows([wf])` dispatch gate for bunx-published workflows, token-gated sub-commands (`_emit-workflow-meta`, `_atomic-run`)

### Worker Scripts (Headless Entry Points)
All per-agent patterns follow `<agent>-worker.ts` naming, using Commander to parse `--<flag> <value>` options matching workflow inputs:

- `examples/hello-world/<agent>-worker.ts` — (x3) Parses `--greeting`, `--style`, `--notes`; calls `runWorkflow()`
- `examples/parallel-hello-world/<agent>-worker.ts` — (x3) Parses `--topic`, fan-out to 3 concurrent stages
- `examples/hil-favorite-color/<agent>-worker.ts` — (x3) Interactive color picker
- `examples/hil-favorite-color-headless/<agent>-worker.ts` — (x3) Headless variant with escalation
- `examples/headless-test/<agent>-worker.ts` — (x3) Parses `--prompt`, mixed visible/headless
- `examples/structured-output-demo/<agent>-worker.ts` — (x3) Parses `--prompt`, validates schema output
- `examples/review-fix-loop/claude-worker.ts` — Parses `--topic`, `--max_iterations`, review loop driver
- `examples/sequential-describe-summarize/claude-worker.ts` — Parses `--topic`, two-stage transcript handoff
- `examples/claude-background-subagents/claude-worker.ts` — No args; writes marker files for subagent gating demo
- `examples/reviewer-tool-test/copilot-worker.ts` — Custom tool runner
- `examples/commander-embed/cli.ts` — Parent CLI with `greet` (workflow) + `status` (plain command) subcommands
- `examples/pane-navigation/cli.ts` — Session manager CLI (`start`, `list`, `status`, `next`, `prev`, `home`, `attach`, `stop`)
- `examples/multi-workflow/cli.ts` — Multi-registry driver using `createRegistry().register().register()` + `listWorkflows()`

---

## Configuration

### Package Manifests
- `examples/hello-world/package.json` — Per-agent `scripts`: `"claude": "bun run claude-worker.ts"`, etc.; `@bastani/atomic-sdk`, `@commander-js/extra-typings` dependencies
- `examples/headless-test/package.json` — Same pattern
- `examples/parallel-hello-world/package.json` — Same pattern
- `examples/hil-favorite-color/package.json` — Same pattern
- `examples/hil-favorite-color-headless/package.json` — Same pattern
- `examples/structured-output-demo/package.json` — Same pattern
- `examples/sequential-describe-summarize/package.json` — Same pattern
- `examples/review-fix-loop/package.json` — Same pattern
- `examples/claude-background-subagents/package.json` — Same pattern
- `examples/custom-workflow-bunx/package.json` — Publishes to `@example/custom-workflow-bunx`
- `examples/commander-embed/package.json` — Same pattern
- `examples/multi-workflow/package.json` — Same pattern
- `examples/pane-navigation/package.json` — Same pattern
- `examples/reviewer-tool-test/package.json` — Same pattern

### SDK Configuration
- `examples/hello-world/.opencode/opencode.json` — MCP config (azure-devops local, github-mcp-server remote), permission `"allow"`, instructions from `~/.atomic/AGENTS.md`

### TypeScript Config
- `examples/tsconfig.json` — Extends root config, path aliases for `@bastani/atomic-sdk` → `../packages/atomic-sdk/src/index.ts`, `@bastani/atomic-sdk/workflows`

---

## Types / Interfaces

### Shared Schema (Structured Output)
- `examples/structured-output-demo/helpers/schema.ts` — `LanguageFactsSchema` (Zod), `LANGUAGE_FACTS_JSON_SCHEMA` (OpenAPI 3.0 JSON Schema), `LanguageFacts` type, `buildPrompt(topic)`, `logFacts(agent, facts)` helper; demonstrates per-SDK native shape mapping (Claude JSON schema, OpenCode JSON schema, Copilot `defineTool`)

---

## Documentation

### Example READMEs (Per-Directory)
- `examples/hello-world/README.md` — Single-session two-turn conversation with structured inputs
- `examples/parallel-hello-world/README.md` — `Promise.all()` fan-out + transcript merge; "JavaScript control flow is the only orchestration primitive"
- `examples/hil-favorite-color/README.md` — Human-in-the-loop interactive pause in tmux pane
- `examples/hil-favorite-color-headless/README.md` — HIL escalation from headless → interactive on prompt arrival; compare with hil-favorite-color
- `examples/headless-test/README.md` — Mixed visible/headless stages; headless stages appear as graph nodes in orchestrator
- `examples/structured-output-demo/README.md` — Per-SDK native structured-output shapes (Claude JSON schema, OpenCode JSON schema, Copilot Zod tool); "Read each `<agent>/index.ts` to see how the same Zod schema lands in three different SDK shapes"
- `examples/sequential-describe-summarize/README.md` — `s.save()` → `s.transcript(handle)` handoff pattern between sessions; canonical data-passing mechanism
- `examples/review-fix-loop/README.md` — Draft → bounded loop(review → fix) with early exit on verdict; "plain `for` with `if` — no DSL, no state machine"
- `examples/claude-background-subagents/README.md` — `run_in_background: true` subagents; stage 2 verifies in-flight gating; marker files at `/tmp/atomic-bg-<n>.txt`
- `examples/reviewer-tool-test/README.md` — Custom Copilot `defineTool` with Zod validation (Copilot-only)
- `examples/commander-embed/README.md` — Embed workflow under parent Commander CLI; compiled binary support via `bun build --compile`; auto-defaults `pathToAtomicExecutable` to `process.execPath`
- `examples/pane-navigation/README.md` — Session manager CLI for pane navigation primitives; catches `SessionNotFoundError` for friendly errors; `--agent` accepts `claude`, `copilot`, `opencode`
- `examples/multi-workflow/README.md` — Multi-workflow registry pattern; `createRegistry().register().register()` + `listWorkflows()` + `getName()` + `getInputSchema()`
- `examples/custom-workflow-bunx/README.md` — Distributed custom workflow via bunx; `hostLocalWorkflows([wf])` dispatch gate for token-gated sub-commands; shows pattern for adding own Commander CLI after `hostLocalWorkflows`
- `examples/headless-test/README.md` — Visible seed → 3 parallel headless → visible merge → headless verdict
- `examples/pane-navigation/README.md` — Demonstrates SDK pane primitives

---

## Notable Clusters

### Per-Agent Workflow Family (hello-world)
- `examples/hello-world/` — 8 files: claude/index.ts, copilot/index.ts, opencode/index.ts, claude-worker.ts, copilot-worker.ts, opencode-worker.ts, package.json, README.md, .opencode/opencode.json
- **Pattern**: Identical DSL definition (inputs, stages) with agent-specific session APIs (`.query()` for Claude, `.send()` for Copilot, `.client.session.prompt()` for OpenCode); demonstrates cross-agent schema portability

### Multi-Agent Coverage (7 examples with full claude/copilot/opencode coverage)
- `examples/hello-world/` — hello-world, single-session 2-turn
- `examples/parallel-hello-world/` — parallel fan-out, transcript merge
- `examples/hil-favorite-color/` — interactive HIL in tmux pane
- `examples/hil-favorite-color-headless/` — HIL headless→interactive escalation
- `examples/headless-test/` — mixed visible/headless stages
- `examples/structured-output-demo/` — per-SDK structured output shapes
- `examples/pane-navigation/` — pane navigation primitives

### Single-Agent Specialized Examples (Claude-only or Copilot-only)
- `examples/sequential-describe-summarize/` — Claude 2-stage transcript handoff
- `examples/review-fix-loop/` — Claude bounded review loop
- `examples/claude-background-subagents/` — Claude background subagents with in-flight gating
- `examples/reviewer-tool-test/` — Copilot custom `defineTool`

### Framework Integration Examples
- `examples/commander-embed/` — Parent Commander CLI embedding workflow; compiled binary support
- `examples/multi-workflow/` — Multi-registry + Commander subcommand dispatcher
- `examples/custom-workflow-bunx/` — Distributed custom workflow via bunx with `hostLocalWorkflows()` dispatch

### Helper & Schema Utilities
- `examples/structured-output-demo/helpers/` — Shared `schema.ts` with Zod definition, JSON Schema export, prompt builders, logging utilities

---

## Summary

The `examples/` directory houses 14 canonical examples totaling 80+ files (~3,981 LOC) demonstrating the full Atomic CLI workflow DSL surface. Examples cluster into three categories:

1. **Multi-Agent Parity** (7 examples covering claude/copilot/opencode): hello-world, parallel, HIL, headless, structured-output, pane-navigation — shows DSL schema portability across SDKs with agent-specific session APIs.

2. **Specialized Patterns** (6 examples): sequential handoff, review loops, background subagents (Claude); custom tools (Copilot); distributed bunx workflows; Commander embedding.

3. **Entrypoint Strategies** (3 patterns): Worker scripts (`<agent>-worker.ts` + Commander), multi-registry with dynamic subcommands, compiled-binary distribution.

All examples use `defineWorkflow()...for("agent").run().compile()` DSL and `runWorkflow({ workflow, inputs })` execution, demonstrating that JavaScript control flow (`Promise.all()`, `for`, `if`) is the only orchestration primitive needed. Shared schema utilities (Zod → per-SDK JSON/tool format) appear in structured-output-demo/helpers/.

