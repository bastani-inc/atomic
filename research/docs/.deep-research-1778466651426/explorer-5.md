# Partition 5 of 12 — Findings

## Scope
`examples/` (55 files, 3,435 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
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

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
### Files Analysed

1. `examples/hello-world/claude/index.ts` — Claude two-turn basic workflow
2. `examples/hello-world/copilot/index.ts` — Copilot variant of the same workflow
3. `examples/hello-world/opencode/index.ts` — OpenCode variant of the same workflow
4. `examples/hello-world/claude-worker.ts` — Worker script that drives `runWorkflow()`
5. `examples/parallel-hello-world/claude/index.ts` — Parallel fan-out via `Promise.all()`
6. `examples/sequential-describe-summarize/claude/index.ts` — Stage handoff via `s.save()` / `s.transcript()`
7. `examples/review-fix-loop/claude/index.ts` — Bounded loop with `handle.result` control flow
8. `examples/structured-output-demo/claude/index.ts` — Headless stage with `outputFormat: json_schema`
9. `examples/structured-output-demo/copilot/index.ts` — Copilot `defineTool` structured-output path
10. `examples/structured-output-demo/opencode/index.ts` — OpenCode `format: json_schema` path
11. `examples/structured-output-demo/helpers/schema.ts` — Shared Zod schema and helper utilities
12. `examples/multi-workflow/cli.ts` — Multi-workflow registry with Commander
13. `examples/multi-workflow/hello/claude.ts` — Minimal subworkflow #1
14. `examples/multi-workflow/goodbye/claude.ts` — Minimal subworkflow #2
15. `examples/custom-workflow-bunx/index.ts` — `hostLocalWorkflows()` dispatch gate
16. `examples/commander-embed/cli.ts` — `runWorkflow()` embedded inside parent Commander CLI
17. `examples/headless-test/claude/index.ts` — Mixed visible/headless stage topology
18. `examples/hil-favorite-color/claude/index.ts` — Human-in-the-loop `AskUserQuestion` flow
19. `examples/hil-favorite-color-headless/claude/index.ts` — Headless HIL regression (tool auto-deny)
20. `examples/claude-background-subagents/claude/index.ts` — `run_in_background: true` subagent gating
21. `examples/reviewer-tool-test/copilot/index.ts` — Copilot `customAgents` + `defineTool` wiring
22. `examples/pane-navigation/claude/index.ts` — Three-stage workflow for navigation-primitive testing
23. `examples/pane-navigation/cli.ts` — Session manager CLI driving tmux navigation primitives

---

### Per-File Notes

#### `examples/hello-world/claude/index.ts`

- **Role:** Canonical baseline workflow for Claude; exercises the full structured-input pipeline end to end with a two-turn conversation.
- **Key symbols:**
  - `defineWorkflow({name, description, inputs})` at line 16 — opens the builder chain. `inputs` array at lines 19–41 declares three fields: `greeting` (string, required), `style` (enum with values `["formal","casual","robotic"]`, default `"casual"`), `notes` (text, optional).
  - `.for("claude")` at line 43 — selects the Claude adapter.
  - `.run(async (ctx) => {...})` at line 44 — receives the workflow execution context.
  - `ctx.stage(meta, {}, {}, async (s) => {...})` at line 46 — single stage named `"hello"`. The second argument is the stage-level DAG dependency map (empty here); the third is per-agent options (empty for Claude in this example).
  - `s.session.query(prompt)` at line 53 — sends a prompt to the Claude CLI session, returns an array of SDK `Message` objects.
  - `s.session.query(...)` at line 60 — second turn in the same session; demonstrates multi-turn within a single stage.
  - `s.save(s.sessionId)` at line 63 — persists the session handle (by session ID string) so downstream stages can read the transcript.
  - `.compile()` at line 67 — finalises the builder and returns the workflow object.
- **Control flow:** `buildHelloPrompt(ctx.inputs)` constructs the prompt string → `ctx.stage` starts the Claude session → `s.session.query` (turn 1, greeting) → `s.session.query` (turn 2, pig-latin translation) → `s.save` persists the handle.
- **Data flow:** `ctx.inputs` (`Record<string,string>`) → `buildHelloPrompt` → prompt string → `s.session.query` → `Message[]` (discarded) → `s.save(s.sessionId)` writes session ID as the handle payload.
- **Dependencies:** `@bastani/atomic-sdk/workflows` (exports `defineWorkflow`).

---

#### `examples/hello-world/copilot/index.ts`

- **Role:** Copilot adapter variant of hello-world; demonstrates the single-turn Copilot session API surface.
- **Key symbols:**
  - `.for("copilot")` at line 43 — selects the Copilot adapter.
  - `s.session.send({ prompt })` at line 51 — Copilot's send primitive (takes `{ prompt: string }` object, not a bare string).
  - `s.save(await s.session.getMessages())` at line 52 — Copilot adapter exposes `getMessages()` instead of a session ID; the resolved message array is the save payload.
- **Control flow:** Single stage → `s.session.send` → `s.session.getMessages()` → `s.save`. No second turn (single-turn Copilot session by design).
- **Data flow:** `ctx.inputs` → `buildHelloPrompt` → `{ prompt }` object → `s.session.send` → `s.session.getMessages()` → `s.save(messages)`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/hello-world/opencode/index.ts`

- **Role:** OpenCode adapter variant; demonstrates the OpenCode `s.client.session.prompt()` API and per-agent options shape.
- **Key symbols:**
  - `.for("opencode")` at line 43.
  - Third argument to `ctx.stage` at lines 49–52: `{ title: "hello", permission: [{ permission: "*", pattern: "*", action: "allow" }] }` — the OpenCode-specific session-creation options, which include a permission allowlist.
  - `s.client.session.prompt({ sessionID: s.session.id, parts: [{ type: "text", text: prompt }] })` at lines 54–57 — OpenCode's structured prompt call; `parts` is an array of typed message parts; `sessionID` is passed explicitly.
  - `s.save(result.data!)` at line 58 — saves the full OpenCode API response object as the handle payload.
- **Control flow:** `ctx.stage` opens with OpenCode options → `s.client.session.prompt` sends the message → `s.save` stores the API result.
- **Data flow:** `ctx.inputs` → `buildHelloPrompt` → `parts[0].text` → `s.client.session.prompt` → `result.data` (OpenCode response) → `s.save`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/hello-world/claude-worker.ts`

- **Role:** CLI driver (worker script) that parses `--<input>` flags from argv and calls `runWorkflow({ workflow, inputs })`. This is the pattern every example's `-worker.ts` file follows.
- **Key symbols:**
  - `getInputSchema(workflow)` at line 9 — retrieves the `inputs` array from the workflow definition at runtime.
  - `program.option(`--${input.name} <value>`, desc)` at line 17 — registers one Commander option per declared input.
  - `runWorkflow({ workflow, inputs: collected })` at line 41 — launches the workflow with the collected flag values.
  - `program.allowExcessArguments(true)` at line 21 — allows free-form positional tokens; these are captured as `this.args` at line 25 and joined into a `"prompt"` key when the workflow has no declared inputs (line 36–38).
  - camelCase normalisation at line 29: `input.name.replace(/-([a-z])/g, ...)` maps kebab-case CLI flags to the Commander opts object's camelCase keys.
- **Control flow:** `getInputSchema` → `program.option` loop → Commander parse → `action` callback → flag-to-key normalisation loop → `runWorkflow`.
- **Data flow:** `process.argv` → Commander opts → `collected: Record<string,string>` → `runWorkflow({ workflow, inputs: collected })`.
- **Dependencies:** `@commander-js/extra-typings`, `@bastani/atomic-sdk/workflows`.

---

#### `examples/parallel-hello-world/claude/index.ts`

- **Role:** Demonstrates parallel fan-out with `Promise.all()` across multiple `ctx.stage` calls, and `s.transcript(handle)` as the cross-stage data channel.
- **Key symbols:**
  - `greet` handle at line 34 — return value of the first sequential `ctx.stage` call; carries the saved session ID.
  - `Promise.all([ctx.stage(...), ctx.stage(...)])` at lines 44–69 — two concurrent stage calls; the runtime spawns them in parallel.
  - `s.transcript(greet)` at lines 51 and 62 — in each parallel branch, resolves the prior stage's handle into a `{ path, content }` object.
  - `prior.path` at lines 52 and 63 — passed directly into the prompt string so Claude can `Read` it via its file tool.
  - `await ctx.stage(merge, ...)` at lines 71–83 — sequential merge stage; reads both parallel handles by calling `s.transcript(formal)` and `s.transcript(casual)`, inlining `.content` directly into the prompt.
- **Control flow:** `greet` stage (sequential) → `[formal, casual]` stages via `Promise.all` (parallel) → `merge` stage (sequential, waits on both `Promise.all` results).
- **Data flow:** `ctx.inputs` → `buildGreetPrompt` → `s.session.query` → `s.save(s.sessionId)` → handle → `s.transcript(handle)` → `{ path, content }` → prompt string → next `s.session.query`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/sequential-describe-summarize/claude/index.ts`

- **Role:** Canonical two-stage sequential handoff; the most didactic demonstration of the `s.save(sessionId)` → `s.transcript(handle)` pipeline.
- **Key symbols:**
  - `describe` handle at line 33 — returned from `ctx.stage` containing the saved session ID.
  - `s.save(s.sessionId)` at line 41 — tells the runtime to read the Claude session's full transcript and write it to disk keyed by the handle.
  - `s.transcript(describe)` at line 54 — in stage 2, resolves handle to `{ path, content }`.
  - `prior.path` at line 56 — passed in the prompt so Claude opens the file directly via its Read tool rather than inlining the content into the prompt.
- **Control flow:** `describe` stage runs `query` → `s.save(sessionId)` → `summarize` stage calls `s.transcript(describe)` → constructs prompt with `prior.path` → runs `query`.
- **Data flow:** `ctx.inputs.topic` → query string → `Message[]` (discarded) → `s.save(s.sessionId)` → disk file → `s.transcript(handle).path` → new prompt → `s.session.query`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/review-fix-loop/claude/index.ts`

- **Role:** Bounded loop workflow demonstrating `handle.result` as control-flow signal and `extractAssistantText` for reading model output.
- **Key symbols:**
  - `extractAssistantText` imported at line 18 from `@bastani/atomic-sdk/workflows` — utility to extract the text content from a `Message[]` at a given message index.
  - `max_iterations` input declared as `type: "integer"` at line 33 — the only `integer`-typed input seen across all examples.
  - `let lastHandle = draft` at line 60 — mutable tracking pointer; updated to `fix` at end of each loop iteration (line 101).
  - Stage callback return value at lines 75–77 — the callback returns `"clean" as const` or `"needs_fix" as const`; this becomes `handle.result` on the returned `SessionHandle`.
  - `review.result === "clean"` at line 81 — reads the typed result from the handle to break the loop early.
  - `for (let i = 1; i <= maxIterations; i++)` at line 62 — bounded loop; each iteration creates dynamically-named stages: `review-${i}`, `fix-${i}`.
  - `extractAssistantText(messages, 0)` at line 74 — parses the Claude response from the returned `Message[]` to determine the verdict string.
- **Control flow:** `draft` stage → `for` loop: `review-i` stage → if `clean`, break; if `needs_fix` and not last iteration → `fix-i` stage → `lastHandle = fix` → next iteration.
- **Data flow:** `s.transcript(lastHandle)` → `prior.path` → query → `Message[]` → `extractAssistantText` → verdict string → `"clean" | "needs_fix"` returned from callback → stored as `handle.result` → read at loop body to branch.
- **Dependencies:** `@bastani/atomic-sdk/workflows` (imports `defineWorkflow`, `extractAssistantText`).

---

#### `examples/structured-output-demo/claude/index.ts`

- **Role:** Demonstrates the Claude headless structured-output path: `outputFormat: { type: "json_schema", schema }` in `s.session.query()` options, result read from `s.session.lastStructuredOutput`.
- **Key symbols:**
  - Stage meta `{ name: "describe", headless: true }` at line 41 — first example of the `headless: true` flag in stage metadata.
  - `s.session.query(buildPrompt(topic), { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, outputFormat: { type: "json_schema", schema: LANGUAGE_FACTS_JSON_SCHEMA } })` at lines 45–52 — `outputFormat` is the Claude SDK structured-output option; `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` are the headless permission bypass flags.
  - `s.session.lastStructuredOutput` at line 60 — Claude adapter property set by the SDK after a structured-output query; holds the validated JSON object.
  - `LanguageFactsSchema.safeParse(s.session.lastStructuredOutput)` at lines 59–63 — Zod validation guard; `parsed.success` gates a typed `LanguageFacts` value.
  - `extractAssistantText(result, 0)` at line 68 — fallback raw-text extraction when structured parse fails.
- **Control flow:** Single headless stage → `s.session.query` with structured output options → `s.session.lastStructuredOutput` read → `LanguageFactsSchema.safeParse` → `logFacts` → throw on failure.
- **Data flow:** `ctx.inputs.prompt` → `buildPrompt` → `s.session.query({ outputFormat })` → `Message[]` + side-effect on `s.session.lastStructuredOutput` → `safeParse` → `LanguageFacts | null`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`, `../helpers/schema.ts`.

---

#### `examples/structured-output-demo/copilot/index.ts`

- **Role:** Copilot structured-output path via `defineTool` with Zod schema; the tool's `handler` fires with pre-validated args, so no manual parse is needed.
- **Key symbols:**
  - `defineTool("submit_facts", { description, parameters: LanguageFactsSchema, skipPermission: true, handler: async (data: LanguageFacts) => {...} })` at lines 46–54 — creates a Copilot custom tool; `parameters` takes the Zod schema directly; `skipPermission: true` suppresses the user-permission prompt; `handler` receives already-typed args.
  - `let captured: LanguageFacts | null = null` at line 45 — closure variable written by the tool handler.
  - `ctx.stage({ name: "describe" }, {}, { tools: [submitFacts] }, ...)` at lines 56–75 — the third argument to `ctx.stage` is the Copilot-specific session options; `tools` is the array of `defineTool` objects made available to the model.
  - `s.session.send({ prompt: buildPrompt(topic) + "\n\nCall the `submit_facts` tool..." })` at line 62–65 — Copilot send call with an augmented prompt instructing tool use.
  - `s.save(await s.session.getMessages())` at line 66.
- **Control flow:** Tool created in closure → stage starts → `s.session.send` → model calls `submit_facts` tool → handler sets `captured` → `s.session.getMessages()` → `s.save` → assert `captured !== null`.
- **Data flow:** Prompt string → `s.session.send` → Copilot SDK routes tool call → handler(`LanguageFacts`) → `captured` variable → `logFacts`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`, `@github/copilot-sdk` (`defineTool`), `../helpers/schema.ts`.

---

#### `examples/structured-output-demo/opencode/index.ts`

- **Role:** OpenCode structured-output path; `format: { type: "json_schema", schema }` passed to `s.client.session.prompt()`; result read from `result.data.info.structured`.
- **Key symbols:**
  - `s.client.session.prompt({ sessionID, parts, format: { type: "json_schema" as const, schema: LANGUAGE_FACTS_JSON_SCHEMA } })` at lines 48–55 — `format` is the OpenCode API's structured-output field.
  - `result.data!.info as { structured?: unknown }` at lines 58–59 — type-cast to access the `structured` field on the OpenCode response's `info` object; the type is asserted because the OpenCode SDK types don't expose `structured` directly.
  - `LanguageFactsSchema.safeParse(structured)` at line 60 — Zod validation of the untyped `structured` value.
  - OpenCode permission options at lines 43–45: `{ title: "describe", permission: [{ permission: "*", pattern: "*", action: "allow" }] }`.
- **Control flow:** Stage opens with OpenCode options → `s.client.session.prompt` with `format` → `result.data!.info.structured` cast and extracted → `safeParse` → `logFacts` → throw on failure.
- **Data flow:** `buildPrompt(topic)` → `parts[{ type: "text", text }]` → `s.client.session.prompt` → `result.data.info.structured` (unknown) → `LanguageFactsSchema.safeParse` → `LanguageFacts | null`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`, `../helpers/schema.ts`.

---

#### `examples/structured-output-demo/helpers/schema.ts`

- **Role:** Shared schema module; provides the Zod schema, JSON Schema derivative, prompt builder, and result logger used by all three agent variants.
- **Key symbols:**
  - `LanguageFactsSchema` at line 21 — `z.object` with five fields: `name` (string), `year_created` (integer), `paradigms` (string array), `statically_typed` (boolean), `summary` (string). Each field carries a `.describe()` annotation consumed by the SDK as JSON Schema `description`.
  - `type LanguageFacts = z.infer<typeof LanguageFactsSchema>` at line 38 — the canonical TypeScript type for the structured output.
  - `LANGUAGE_FACTS_JSON_SCHEMA = z.toJSONSchema(LanguageFactsSchema, { target: "openapi-3.0" })` at lines 49–51 — converts Zod to JSON Schema with `target: "openapi-3.0"` to suppress the `$schema` draft URL that the Claude Agent SDK's validator rejects.
  - `buildPrompt(topic)` at line 53 — returns a string instructing the model to fill all fields from known facts.
  - `logFacts(agent, facts)` at line 65 — logs the validated object or a missing indicator; uses `console.log` (not a workflow logger) deliberately for visibility.
- **Data flow:** `LanguageFactsSchema` → `z.toJSONSchema(...)` → `LANGUAGE_FACTS_JSON_SCHEMA` (used by Claude and OpenCode); `LanguageFactsSchema` used directly as `parameters` in Copilot `defineTool`.
- **Dependencies:** `zod`.

---

#### `examples/multi-workflow/cli.ts`

- **Role:** Multi-registry driver; demonstrates `createRegistry().register().register()` and the `listWorkflows` / `getName` / `getInputSchema` reflection API.
- **Key symbols:**
  - `createRegistry()` at line 26 — constructs an empty workflow registry.
  - `.register(hello).register(goodbye)` at line 26 — registers two workflow objects; returns the registry (fluent).
  - `listWorkflows(registry)` at line 32 — returns an iterable of registered workflow objects.
  - `getName(workflow)` at line 34 — reflects the workflow's declared `name`.
  - `getInputSchema(workflow)` at line 37 — reflects the workflow's declared `inputs` array.
  - `sub.action(async (rawOpts) => { ... await runWorkflow({ workflow, inputs: collected }); })` at lines 47–61 — one Commander subcommand per workflow; camelCase-to-kebab normalisation at line 51.
  - `await program.parseAsync()` at line 64 — entry point.
- **Control flow:** `createRegistry` → `register` × 2 → `listWorkflows` → `for` loop creates one Commander `sub` per workflow → `getInputSchema` drives `sub.option` loop → `sub.action` calls `runWorkflow`.
- **Data flow:** `listWorkflows(registry)` → workflow objects → `getName`/`getInputSchema` → Commander options → `rawOpts` → `collected: Record<string,string>` → `runWorkflow({ workflow, inputs: collected })`.
- **Dependencies:** `@commander-js/extra-typings`, `@bastani/atomic-sdk/workflows` (imports `createRegistry`, `getInputSchema`, `getName`, `listWorkflows`, `runWorkflow`).

---

#### `examples/multi-workflow/hello/claude.ts` and `examples/multi-workflow/goodbye/claude.ts`

- **Role:** Minimal single-stage subworkflows used as registry entries.
- **Key symbols (hello):** `defineWorkflow({ name: "hello", inputs: [{ name: "who", type: "string", default: "world" }] }).for("claude").run(...).compile()` — lines 3–22. Single stage `"greet"` with `s.session.query` and `s.save(s.sessionId)`.
- **Key symbols (goodbye):** `defineWorkflow({ name: "goodbye", inputs: [{ name: "tone", type: "enum", values: ["formal","casual","melodramatic"], default: "casual" }] }).for("claude").run(...).compile()` — lines 3–25. Single stage `"farewell"`.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/custom-workflow-bunx/index.ts`

- **Role:** Demonstrates `hostLocalWorkflows([wf])` — the dispatch gate for workflows published as bunx-runnable scripts.
- **Key symbols:**
  - `hostLocalWorkflows` imported from `@bastani/atomic-sdk` at line 2 (top-level re-export, not `/workflows` subpath).
  - `defineWorkflow({...}).for("claude").run(...).compile()` at lines 4–31 — single-stage `"explain-file"` workflow with one `"text"`-typed `"path"` input.
  - `await hostLocalWorkflows([explainFile])` at line 33 — invoked at the top level; this is the server-side dispatch gate that handles `_emit-workflow-meta` and `_atomic-run` IPC tokens from the Atomic TUI.
- **Control flow:** Script loaded by bunx → `hostLocalWorkflows` handles IPC dispatch → on `_atomic-run`, calls `runWorkflow` with the compiled workflow and provided inputs.
- **Data flow:** IPC message from Atomic TUI → `hostLocalWorkflows` dispatcher → `runWorkflow({ workflow: explainFile, inputs })`.
- **Dependencies:** `@bastani/atomic-sdk` (top-level).

---

#### `examples/commander-embed/cli.ts`

- **Role:** Shows `runWorkflow()` embedded inside a parent Commander CLI alongside unrelated `status` subcommand; no special "orchestrator mode" env vars needed.
- **Key symbols:**
  - `getInputSchema(workflow)` at line 30 — reflects the embedded workflow's inputs.
  - `greet.option(...)` loop at lines 33–38 — mounts each input as a `--<name>` flag on the `greet` subcommand.
  - `await runWorkflow({ workflow, inputs: collected })` at line 53 — called from inside a Commander action; the SDK's orchestrator entry script manages the tmux session.
  - Plain `program.command("status").action(() => { console.log("ok"); })` at lines 57–62 — sibling subcommand with no atomic involvement.
- **Control flow:** Commander parses argv → routes to either `greet` action (calls `runWorkflow`) or `status` action (plain log).
- **Dependencies:** `@commander-js/extra-typings`, `@bastani/atomic-sdk/workflows` (`getInputSchema`, `runWorkflow`).

---

#### `examples/headless-test/claude/index.ts`

- **Role:** Tests the full headless/visible stage topology: visible seed → three parallel headless stages → visible merge → headless verdict. Also demonstrates `extractAssistantText` as a return value from stage callbacks.
- **Key symbols:**
  - `{ name: "seed" }` at line 21 — visible (no `headless` flag) stage; `extractAssistantText(result, 0)` returned at line 30 becomes `seed.result`.
  - `{ name: "pros", headless: true }` at line 37 — headless stage; `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` at line 43 are required for headless.
  - `Promise.all([...three headless stages...])` at lines 35–75 — parallel fan-out of headless stages.
  - `prosHandle.result`, `consHandle.result`, `usesHandle.result` at lines 87–89 — inline result values from the parallel handles, inlined directly into the merge prompt (not via `s.transcript`).
  - `{ name: "verdict", headless: true }` at line 98 — final headless stage; its comment documents that it tests orchestrator timer survival.
- **Control flow:** `seed` (visible, sequential) → `[pros, cons, uses]` (headless, parallel) → `merge` (visible, sequential) → `verdict` (headless, sequential).
- **Data flow:** `seed.result` (string from `extractAssistantText`) → inlined into parallel headless prompts → `prosHandle.result` / `consHandle.result` / `usesHandle.result` → inlined into merge prompt → merge stage result inlined into verdict prompt.
- **Dependencies:** `@bastani/atomic-sdk/workflows` (`defineWorkflow`, `extractAssistantText`).

---

#### `examples/hil-favorite-color/claude/index.ts`

- **Role:** Human-in-the-loop demonstration; stage 1 instructs Claude to invoke `AskUserQuestion` tool; stage 2 reads the color from the transcript.
- **Key symbols:**
  - `AskUserQuestion` (string literal in prompt at line 29) — the Claude tool name the runtime's transcript watcher monitors to flip the node card to `"awaiting_input"` state.
  - Stage 1 prompt at lines 28–35 — array joined with newlines, instructs exactly one `AskUserQuestion` call, free-form text answer, then echo back.
  - `s.transcript(askColor)` at line 48 — resolves stage 1's handle to `{ path, content }`.
  - `prior.path` inlined in stage 2 prompt at line 52 — lets Claude read the HIL transcript directly.
- **Control flow:** `ask-color` stage → runtime detects `AskUserQuestion` invocation → waits for human response → stage completes → `describe-color` stage reads transcript.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/hil-favorite-color-headless/claude/index.ts`

- **Role:** Regression test for headless HIL handling; `headless: true` causes the runtime to inject `disallowedTools: ["AskUserQuestion"]`, so the tool call is denied and the agent must self-answer.
- **Key symbols:**
  - `{ name: "ask-color-headless", headless: true }` at lines 22–25 — headless flag triggers automatic `AskUserQuestion` denial.
  - `permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true` at lines 40–41 — headless permission bypass.
  - `extractAssistantText(result, 0)` at line 45 — captures the text answer returned when the tool is denied.
  - Prompt lines 33–39 — instructs the model to use `AskUserQuestion`, but also includes fallback: "If the tool is unavailable or denied, pick a plausible answer yourself."
- **Control flow:** Headless stage → `s.session.query` → runtime blocks `AskUserQuestion` → agent falls back to answering directly → `extractAssistantText` → `s.save`.
- **Dependencies:** `@bastani/atomic-sdk/workflows` (`defineWorkflow`, `extractAssistantText`).

---

#### `examples/claude-background-subagents/claude/index.ts`

- **Role:** Tests in-flight subagent gating: stage 1 dispatches three `run_in_background: true` subagents via the `Agent` tool and ends its turn immediately; stage 2 verifies all three marker files exist, proving the Stop-hook gate held until all `SubagentStop` events fired.
- **Key symbols:**
  - `MARKER_PATHS` at lines 28 — `["/tmp/atomic-bg-1.txt", "/tmp/atomic-bg-2.txt", "/tmp/atomic-bg-3.txt"]`.
  - Stage 1 `"dispatch"` at line 47 — prompt at lines 58–78 explicitly names the `Agent` tool, instructs `run_in_background: true` for each subagent, and tells Claude to end turn immediately after dispatching.
  - `void dispatch` at line 93 — deliberate no-op reference to suppress "unused variable" TypeScript warning; stage 2 does not read stage 1's transcript.
  - Stage 2 `"verify"` at line 94 — prompt at lines 102–114 instructs Claude to Read each marker file and report FAILURE if any is missing.
- **Control flow:** `dispatch` stage → Claude dispatches 3 background `Agent` tool calls → Claude ends turn → Stop hook holds until all `SubagentStop` events → `verify` stage spawns → Claude reads marker files → reports SUCCESS or FAILURE.
- **Data flow:** `MARKER_PATHS` array → prompt string → `s.session.query` → (background subagents write files) → stage 2 query reads files via Claude Read tool → report.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/reviewer-tool-test/copilot/index.ts`

- **Role:** Proves Copilot `customAgents` + `defineTool` integration: a named inline reviewer subagent can call a workflow-registered custom tool (`submit_review`) that Copilot's frontmatter parser would otherwise filter out.
- **Key symbols:**
  - `SubmitReviewSchema` at line 27 — `z.object({ verdict: z.enum([...]), explanation: z.string() })`.
  - `defineTool("submit_review", { description, parameters: SubmitReviewSchema, skipPermission: true, handler })` at lines 66–74 — Copilot custom tool.
  - `inlineReviewer: CustomAgentConfig` at lines 76–84 — inline subagent definition: `{ name, displayName, description, tools: ["execute","read","search","submit_review"], prompt }`. The `tools` array is validated against the live tool registry (not the frontmatter registry), so `submit_review` resolves.
  - `ctx.stage({ name: "review" }, {}, { agent: "reviewer", tools: [submitReview], customAgents: [inlineReviewer] }, ...)` at lines 86–113 — third `ctx.stage` arg for Copilot includes `agent` (the subagent name to use), `tools`, and `customAgents`.
  - `s.session.send({ prompt: REVIEW_PROMPT })` at line 102.
  - `s.save(await s.session.getMessages())` at line 103.
- **Control flow:** `defineTool` creates tool in closure → `inlineReviewer` config defined → stage starts with Copilot options including both → `s.session.send` → model calls `submit_review` → handler sets `captured` → assertion.
- **Dependencies:** `@bastani/atomic-sdk/workflows`, `@github/copilot-sdk` (`defineTool`, `CustomAgentConfig`), `zod`.

---

#### `examples/pane-navigation/claude/index.ts`

- **Role:** Minimal three-stage workflow whose sole purpose is producing four navigable tmux windows (orchestrator + alpha + bravo + charlie) for the navigation-primitive tests in `../cli.ts`.
- **Key symbols:**
  - Three sequential `ctx.stage` calls at lines 22–49, each with a single `s.session.query` returning a one-word answer.
  - No `Promise.all`, no `s.transcript`, no `s.save` beyond `s.save(s.sessionId)` in each stage.
- **Dependencies:** `@bastani/atomic-sdk/workflows`.

---

#### `examples/pane-navigation/cli.ts`

- **Role:** Session manager CLI exercising the SDK's tmux navigation primitives: `nextWindow`, `previousWindow`, `gotoOrchestrator`, `attachSession`, `stopSession`, `listSessions`, `getSessionStatus`, `runWorkflow({ ..., detach: true })`.
- **Key symbols:**
  - `runWorkflow({ workflow, detach: true })` at line 71 — `detach: true` flag spawns the workflow in the background and returns `{ tmuxSessionName }` immediately.
  - `result.tmuxSessionName` at line 72 — printed so the user can attach manually.
  - `listSessions({ scope: "workflow" })` at line 79 — lists active workflow sessions on the atomic tmux socket; each session has `{ id, attached, agent, created }`.
  - `getSessionStatus(id)` at line 94 — reads the on-disk JSON status snapshot for a workflow session.
  - `nextWindow(id)` at line 105, `previousWindow(id)` at line 110, `gotoOrchestrator(id)` at line 115, `attachSession(id)` at line 120, `stopSession(id)` at line 124 — SDK tmux navigation functions.
  - `SessionNotFoundError` at line 38 — SDK error class; caught in `handleErrors` at line 133 and translated to a clean exit with an actionable hint.
  - `WORKFLOWS` map at lines 47–51 — `{ claude: claudeWorkflow, copilot: copilotWorkflow, opencode: opencodeWorkflow }` typed `satisfies Record<AgentType, unknown>`.
- **Control flow:** `start` subcommand → `runWorkflow({ detach: true })` → print session ID. Other subcommands take a session ID and call the corresponding SDK primitive → `handleErrors` wrapper translates `SessionNotFoundError`.
- **Dependencies:** `@bastani/atomic-sdk` (top-level, imports `attachSession`, `getSessionStatus`, `gotoOrchestrator`, `listSessions`, `nextWindow`, `previousWindow`, `runWorkflow`, `SessionNotFoundError`, `stopSession`, `AgentType`), `@commander-js/extra-typings`.

---

### Cross-Cutting Synthesis

The `examples/` directory is a comprehensive exerciser of the `@bastani/atomic-sdk` DSL. Every workflow follows an identical builder chain: `defineWorkflow({ name, description, inputs })` → `.for(agent)` → `.run(async (ctx) => {...})` → `.compile()`. The `.for()` call is the sole branch point for per-agent adapter selection; from the workflow author's perspective, `ctx.stage` is uniform across all three agents — only the stage callback's session API differs: Claude uses `s.session.query(prompt, opts?)` with `s.save(s.sessionId)` and `s.transcript(handle)` for cross-stage data; Copilot uses `s.session.send({ prompt })` and `s.save(await s.session.getMessages())`; OpenCode uses `s.client.session.prompt({ sessionID, parts, ...opts })` and `s.save(result.data!)`. Parallel fan-out is plain `Promise.all([ctx.stage(...), ...])` with no special DSL syntax. The loop pattern uses a JavaScript `for` loop with dynamically-named stages and `handle.result` (the typed return value of the stage callback) as the branch signal. Headless stages carry `{ headless: true }` in their metadata and require `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` in the query options. Structured output diverges maximally by agent: Claude reads from `s.session.lastStructuredOutput` after passing `outputFormat: { type: "json_schema", schema }` to `query`; OpenCode reads from `result.data.info.structured` after passing `format: { type: "json_schema", schema }` to `s.client.session.prompt`; Copilot uses a `defineTool` closure with `parameters: ZodSchema`. Every example has a parallel `-worker.ts` CLI driver that uses `getInputSchema` + Commander to parse flags and calls `runWorkflow({ workflow, inputs })`. The multi-workflow pattern adds `createRegistry().register().register()` and the reflection API (`listWorkflows`, `getName`, `getInputSchema`). The `hostLocalWorkflows([wf])` call in `custom-workflow-bunx/index.ts` is the bunx-dispatch entry point. The `pane-navigation/cli.ts` exposes the full session-management surface: `runWorkflow({ detach: true })`, `listSessions`, `getSessionStatus`, `nextWindow`, `previousWindow`, `gotoOrchestrator`, `attachSession`, `stopSession`, `SessionNotFoundError`.

---

### Out-of-Partition References

All references below are imported by example files and resolved outside the `examples/` directory:

- **`@bastani/atomic-sdk/workflows`** — primary import across all workflow files; exports: `defineWorkflow`, `extractAssistantText`, `runWorkflow`, `getInputSchema`, `getName`, `listWorkflows`, `createRegistry`. Resolved in `packages/atomic-sdk/src/workflows/` (partition 9 or 10).
- **`@bastani/atomic-sdk`** (top-level) — used by `custom-workflow-bunx/index.ts` (imports `defineWorkflow`, `hostLocalWorkflows`) and `pane-navigation/cli.ts` (imports `attachSession`, `getSessionStatus`, `gotoOrchestrator`, `listSessions`, `nextWindow`, `previousWindow`, `runWorkflow`, `stopSession`, `SessionNotFoundError`, `AgentType`). Resolved in `packages/atomic-sdk/src/index.ts`.
- **`@github/copilot-sdk`** — used by Copilot variant files; exports `defineTool`, `CustomAgentConfig`. Resolved in `node_modules/@github/copilot-sdk` (SDK package, partition 7 coverage area).
- **`@commander-js/extra-typings`** — used by all worker scripts and multi-workflow CLI; resolved in `node_modules/@commander-js/extra-typings`.
- **`zod`** — used by `helpers/schema.ts` and `reviewer-tool-test/copilot/index.ts`; `z.toJSONSchema` with `target: "openapi-3.0"` is the JSON Schema conversion path. Resolved in `node_modules/zod`.
- **`./claude/index.ts`, `./copilot/index.ts`, `./opencode/index.ts`** — cross-agent sibling imports within the same example directory (e.g., `pane-navigation/cli.ts` imports all three agent variants).

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
# Pattern Finder Results: Atomic CLI Examples Directory

## Scope
`examples/` directory (55 files, 3,435 LOC) — canonical reference implementations for pi-coding-agent rewrite

---

## Patterns Found

#### Pattern 1: Basic defineWorkflow with CLI Worker Scripts
**Where:** `examples/hello-world/claude/index.ts:16-67`
**What:** Foundational single-stage workflow with structured inputs (string, enum, text) and CLI parameter parsing via Commander.

```typescript
export default defineWorkflow({
    name: "hello-world",
    description: "A simple single-session hello world workflow (two turns)",
    inputs: [
      {
        name: "greeting",
        type: "string",
        required: true,
        description: "the opening phrase the agent should echo back",
        placeholder: "Hello, world!",
      },
      {
        name: "style",
        type: "enum",
        required: true,
        description: "tone of the response",
        values: ["formal", "casual", "robotic"],
        default: "casual",
      },
      {
        name: "notes",
        type: "text",
        description: "extra guidance for the agent (optional)",
        placeholder: "anything you want to add…",
      },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(
      { name: "hello", description: "Say hello to the world" },
      {},
      {},
      async (s) => {
        await s.session.query(prompt);
        await s.session.query("Now translate your previous greeting into pig latin. One line only.");
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

**Variations / call-sites:**
- Claude variant: `hello-world/claude/index.ts:16`
- OpenCode variant: `hello-world/opencode/index.ts:16` (uses `s.client.session.prompt()` and permission config)
- Copilot variant: `hello-world/copilot/index.ts:16` (uses `s.session.send()` and `getMessages()`)
- Worker script: `hello-world/claude-worker.ts:1-44` (parses CLI options, calls `runWorkflow`)

---

#### Pattern 2: Multi-Workflow CLI with Registry
**Where:** `examples/multi-workflow/cli.ts:26-64`
**What:** Compose multiple workflows under one CLI entrypoint using `createRegistry` and Commander subcommands.

```typescript
const registry = createRegistry().register(hello).register(goodbye);

const program = new Command("multi-workflow").description(
  "Two small Claude workflows under one entrypoint",
);

for (const workflow of listWorkflows(registry)) {
  const sub = program
    .command(getName(workflow))
    .description(workflow.description);

  const inputs = getInputSchema(workflow);
  for (const input of inputs) {
    const desc =
      input.description ??
      (input.type === "enum"
        ? `one of: ${(input.values ?? []).join(", ")}`
        : input.type);
    sub.option(`--${input.name} <value>`, desc);
  }

  sub.action(async (rawOpts) => {
    const opts = rawOpts as Record<string, string | undefined>;
    const collected: Record<string, string> = {};
    for (const input of inputs) {
      const camelKey = input.name.replace(
        /-([a-z])/g,
        (_, c: string) => c.toUpperCase(),
      );
      const value = opts[camelKey] ?? opts[input.name];
      if (typeof value === "string" && value !== "") {
        collected[input.name] = value;
      }
    }
    await runWorkflow({ workflow, inputs: collected });
  });
}

await program.parseAsync();
```

**Variations / call-sites:**
- Individual workflows: `multi-workflow/hello/claude.ts` and `multi-workflow/goodbye/claude.ts`
- Package: `multi-workflow/package.json` (scripts: "bun run multi-workflow/cli.ts")

---

#### Pattern 3: Headless Background Stages
**Where:** `examples/headless-test/claude/index.ts:20-111`
**What:** Mixed visible and headless stages with parallel execution and transcript handoff using `Promise.all()`.

```typescript
// ── Visible stage: seed ──
const seed = await ctx.stage(
  { name: "seed", description: "Generate a topic overview" },
  {},
  {},
  async (s) => {
    const result = await s.session.query(
      `In one short paragraph, describe what "${prompt}" is.`,
    );
    s.save(s.sessionId);
    return extractAssistantText(result, 0);
  },
);

// ── Three parallel headless background stages ──
const [prosHandle, consHandle, usesHandle] = await Promise.all([
  ctx.stage(
    { name: "pros", headless: true },
    {},
    {},
    async (s) => {
      const result = await s.session.query(
        `Given this topic overview, list 3 pros:\n\n${seed.result}`,
        { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      );
      s.save(s.sessionId);
      return extractAssistantText(result, 0);
    },
  ),
  // ... two more stages ...
]);

// ── Visible stage: merge results from background stages ──
const mergeHandle = await ctx.stage(
  { name: "merge", description: "Combine background results" },
  {},
  {},
  async (s) => {
    const result = await s.session.query(
      [
        "Combine these three analyses into a concise summary:\n",
        `## Pros\n${prosHandle.result}`,
        `## Cons\n${consHandle.result}`,
        `## Use Cases\n${usesHandle.result}`,
      ].join("\n\n"),
    );
    s.save(s.sessionId);
    return extractAssistantText(result, 0);
  },
);
```

**Variations / call-sites:**
- Parallel execution: `headless-test/claude/index.ts:35-75`
- Headless mode validation: `hil-favorite-color-headless/claude/index.ts` (verify AskUserQuestion is blocked)
- OpenCode headless: `hil-favorite-color-headless/opencode/index.ts` (scopes `OPENCODE_CLIENT=sdk` to disable question tool)

---

#### Pattern 4: Sequential Stage Handoff with Transcripts
**Where:** `examples/sequential-describe-summarize/claude/index.ts:32-62`
**What:** Two-stage pipeline where stage 1 produces a result, persists it via `s.save()`, and stage 2 reads it via `s.transcript()`.

```typescript
// Stage 1: produce a detailed description
const describe = await ctx.stage(
  { name: "describe", description: "Produce a detailed paragraph about the topic" },
  {},
  {},
  async (s) => {
    await s.session.query(
      `Write one detailed paragraph (4–6 sentences) explaining ${topic} to an engineering audience.`,
    );
    s.save(s.sessionId);
  },
);

// Stage 2: read stage 1's transcript file off disk and compress it
await ctx.stage(
  { name: "summarize", description: "Compress the description into two bullets" },
  {},
  {},
  async (s) => {
    const prior = await s.transcript(describe);
    await s.session.query(
      `Read the description in ${prior.path} and condense it into exactly two bullet points.`,
    );
    s.save(s.sessionId);
  },
);
```

**Variations / call-sites:**
- Parallel variant: `parallel-hello-world/claude/index.ts:34-84` (two parallel stages read from seed)
- Copilot variant: `parallel-hello-world/copilot/index.ts:50-54` (reads `prior.content` directly instead of path)
- Loop variant: `review-fix-loop/claude/index.ts:45-101` (loop with early exit and state tracking via `lastHandle`)

---

#### Pattern 5: Multi-Agent Workflow (Claude, Copilot, OpenCode)
**Where:** `examples/hello-world/{claude,copilot,opencode}/index.ts` (agent-specific implementations)
**What:** Same workflow shape with agent-specific session API (Claude: `.query()`, Copilot: `.send()`, OpenCode: `.prompt()`).

Claude variant (lines 44-65):
```typescript
  .for("claude")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(...async (s) => {
      await s.session.query(prompt);
      s.save(s.sessionId);
    });
  })
```

OpenCode variant (lines 44-61):
```typescript
  .for("opencode")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(
      ...,
      { title: "hello", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: prompt }],
        });
        s.save(result.data!);
      },
    );
  })
```

Copilot variant (lines 44-55):
```typescript
  .for("copilot")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(...async (s) => {
      await s.session.send({ prompt });
      s.save(await s.session.getMessages());
    });
  })
```

**Variations / call-sites:**
- Structured output: `structured-output-demo/{claude,opencode,copilot}/index.ts`
- HIL (Human-in-the-loop): `hil-favorite-color/{claude,opencode}/index.ts`
- Parallel: `parallel-hello-world/{claude,copilot,opencode}/index.ts`

---

#### Pattern 6: Structured Output with Zod Schema
**Where:** `examples/structured-output-demo/helpers/schema.ts:21-51` and `structured-output-demo/claude/index.ts:40-79`
**What:** Define Zod schema, convert to JSON Schema, validate against agent's structured output.

Schema definition (lines 21-36):
```typescript
export const LanguageFactsSchema = z.object({
  name: z.string().describe("Canonical language name, e.g. 'Python'"),
  year_created: z.number().int().describe("Year the language was first released"),
  paradigms: z.array(z.string()).describe("Programming paradigms"),
  statically_typed: z.boolean().describe("True if statically typed by default"),
  summary: z.string().describe("One-sentence summary"),
});

export const LANGUAGE_FACTS_JSON_SCHEMA = z.toJSONSchema(LanguageFactsSchema, {
  target: "openapi-3.0",
});
```

Claude validation (lines 45-76):
```typescript
const result = await s.session.query(buildPrompt(topic), {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  outputFormat: {
    type: "json_schema",
    schema: LANGUAGE_FACTS_JSON_SCHEMA,
  },
});
s.save(s.sessionId);

const parsed = LanguageFactsSchema.safeParse(
  s.session.lastStructuredOutput,
);
const facts: LanguageFacts | null = parsed.success ? parsed.data : null;
logFacts("claude", facts);
```

**Variations / call-sites:**
- OpenCode variant: `structured-output-demo/opencode/index.ts:48-73` (reads from `result.data.info.structured`)
- Copilot variant: `structured-output-demo/copilot/index.ts` (defineTool with `parameters: LanguageFactsSchema`)

---

#### Pattern 7: Human-in-the-Loop (HIL) Stages
**Where:** `examples/hil-favorite-color/claude/index.ts:17-59`
**What:** Stage with `AskUserQuestion` tool that blocks execution until user responds; state tracked via transcript.

```typescript
export default defineWorkflow({
    name: "hil-favorite-color",
    description:
      "Test HIL: stage 1 asks the user for their favorite color via AskUserQuestion; stage 2 describes it",
  })
  .for("claude")
  .run(async (ctx) => {
    const askColor = await ctx.stage(
      {
        name: "ask-color",
        description: "Ask the user for their favorite color (HIL)",
      },
      {},
      {},
      async (s) => {
        await s.session.query(
          [
            "You must use the AskUserQuestion tool exactly once to ask the user:",
            '"What is your favorite color?"',
            "",
            "Allow a free-form text answer. Do not guess — wait for the user's response.",
            "After they answer, echo back a single sentence acknowledging their choice.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );

    await ctx.stage(
      {
        name: "describe-color",
        description: "Write a short description of the chosen color",
      },
      {},
      {},
      async (s) => {
        const prior = await s.transcript(askColor);
        await s.session.query(
          [
            `Read ${prior.path}. It contains a transcript in which the user named their favorite color.`,
            "Write a short (2–3 sentence) evocative description of that color.",
            "Do not ask any follow-up questions.",
          ].join("\n"),
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

**Variations / call-sites:**
- Headless regression test: `hil-favorite-color-headless/claude/index.ts` (verifies tool is blocked in headless mode)
- OpenCode variant: `hil-favorite-color/opencode/index.ts` (uses client's question tool)

---

#### Pattern 8: Pane Navigation CLI (SDK Primitives)
**Where:** `examples/pane-navigation/cli.ts:30-147`
**What:** SDK primitives for spawning workflows detached and navigating tmux windows programmatically.

```typescript
const WORKFLOWS = {
  claude: claudeWorkflow,
  copilot: copilotWorkflow,
  opencode: opencodeWorkflow,
} as const satisfies Record<AgentType, unknown>;

program
  .command("start")
  .description("Spawn the pane-navigation workflow detached and print its session id")
  .requiredOption("--agent <agent>", "agent backend (claude | copilot | opencode)")
  .action(async (opts) => {
    const agent = opts.agent as AgentType;
    const workflow = WORKFLOWS[agent];
    const result = await runWorkflow({ workflow, detach: true });
    console.log(result.tmuxSessionName);
  });

program
  .command("list")
  .description("List workflow sessions on the atomic socket")
  .action(() => {
    const sessions = listSessions({ scope: "workflow" });
    for (const s of sessions) {
      const flag = s.attached ? "*" : " ";
      console.log(\`${flag} ${s.id}  agent=${s.agent ?? "?"}  created=${s.created}\`);
    }
  });

program
  .command("next <id>")
  .description("Move the session's current-window pointer to the next window")
  .action((id: string) => handleErrors(() => nextWindow(id)));

program
  .command("prev <id>")
  .description("Move the session's current-window pointer to the previous window")
  .action((id: string) => handleErrors(() => previousWindow(id)));

program
  .command("home <id>")
  .description("Jump to the orchestrator window (window 0) of the session")
  .action((id: string) => handleErrors(() => gotoOrchestrator(id)));

program
  .command("attach <id>")
  .description("Attach this terminal to the session interactively")
  .action((id: string) => handleErrors(() => attachSession(id)));

program
  .command("stop <id>")
  .description("Kill the session (best-effort; idempotent)")
  .action(async (id: string) => {
    await stopSession(id);
  });
```

**Variations / call-sites:**
- Three-stage workflow: `pane-navigation/{claude,copilot,opencode}/index.ts:16-52`

---

#### Pattern 9: Commander Embed (Headless Integration)
**Where:** `examples/commander-embed/cli.ts:17-64`
**What:** Mount a workflow as a Commander subcommand alongside plain CLI commands.

```typescript
const program = new Command("my-app").description(
  "Demo CLI with an atomic workflow alongside plain Commander commands",
);

// ── greet — mount the workflow's inputs as --<input> options ──────────
const greet = program.command("greet").description(workflow.description);

const inputs = getInputSchema(workflow);
for (const input of inputs) {
  const desc =
    input.description ??
    (input.type === "enum"
      ? \`one of: ${(input.values ?? []).join(", ")}\`
      : input.type);
  greet.option(\`--${input.name} <value>\`, desc);
}

greet.action(async (rawOpts) => {
  const opts = rawOpts as Record<string, string | undefined>;
  const collected: Record<string, string> = {};
  for (const input of inputs) {
    const camelKey = input.name.replace(
      /-([a-z])/g,
      (_, c: string) => c.toUpperCase(),
    );
    const value = opts[camelKey] ?? opts[input.name];
    if (typeof value === "string" && value !== "") {
      collected[input.name] = value;
    }
  }
  await runWorkflow({ workflow, inputs: collected });
});

// ── A plain Commander sibling — no atomic involvement ───────────────────
program
  .command("status")
  .description("Print a trivial status line")
  .action(() => {
    console.log("ok");
  });

await program.parseAsync();
```

**Variations / call-sites:**
- Related: `multi-workflow/cli.ts` (multiple workflows under same program)

---

#### Pattern 10: Review/Fix Loop with Bounded Iterations
**Where:** `examples/review-fix-loop/claude/index.ts:44-104`
**What:** Generate → review → (if needed) fix loop with early exit on `"clean"` verdict and state tracking.

```typescript
const draft = await ctx.stage(
  { name: "draft", description: "Produce the initial two-paragraph draft" },
  {},
  {},
  async (s) => {
    await s.session.query(
      \`Write a two-paragraph argument for ${topic}. Be concrete — cite at least two specific benefits.\`,
    );
    s.save(s.sessionId);
  },
);

let lastHandle = draft;

for (let i = 1; i <= maxIterations; i++) {
  const review = await ctx.stage(
    { name: \`review-${i}\`, description: "Judge the latest draft" },
    {},
    {},
    async (s) => {
      const prior = await s.transcript(lastHandle);
      const messages = await s.session.query(
        \`Read the draft in ${prior.path}. Reply with either "CLEAN" if ready, or "NEEDS_FIX: <issue>".\`,
      );
      s.save(s.sessionId);

      const verdict = extractAssistantText(messages, 0).toUpperCase();
      return verdict.includes("CLEAN") && !verdict.includes("NEEDS_FIX")
        ? ("clean" as const)
        : ("needs_fix" as const);
    },
  );

  if (review.result === "clean") break;

  if (i === maxIterations) break;

  const fix = await ctx.stage(
    { name: \`fix-${i}\`, description: "Address the review's top issue" },
    {},
    {},
    async (s) => {
      const priorDraft = await s.transcript(lastHandle);
      const reviewFeedback = await s.transcript(review);
      await s.session.query(
        \`Read the draft in ${priorDraft.path} and the feedback in ${reviewFeedback.path}. Produce a revised draft.\`,
      );
      s.save(s.sessionId);
    },
  );

  lastHandle = fix;
}
```

**Variations / call-sites:**
- Structured iteration: No direct variants; this is the canonical loop pattern

---

#### Pattern 11: Local Workflow Hosting (hostLocalWorkflows)
**Where:** `examples/custom-workflow-bunx/index.ts:1-33`
**What:** Self-contained script exporting workflows via `hostLocalWorkflows` for dynamic execution.

```typescript
#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

const explainFile = defineWorkflow({
  name: "explain-file",
  description: "Open a Claude pane that walks through a file",
  inputs: [
    {
      name: "path",
      type: "text",
      required: true,
      description: "absolute or relative path to the file to explain",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "explain", description: "Read the file and walk through it" },
      {},
      {},
      async (s) => {
        await s.session.query(
          \`Read ${ctx.inputs.path} and walk me through what it does. \` +
            \`Highlight any non-obvious behaviour or invariants. Keep it under 10 short sentences.\`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();

await hostLocalWorkflows([explainFile]);
```

**Variations / call-sites:**
- Standalone entry script (no separate worker needed)

---

#### Pattern 12: Background Subagents with In-Flight Gating
**Where:** `examples/claude-background-subagents/claude/index.ts:37-120`
**What:** Dispatch multiple background subagents and wait for them to finish before advancing to the next stage.

```typescript
const dispatch = await ctx.stage(
  {
    name: "dispatch",
    description: "Spawn three background subagents that each sleep 20s and write a marker file",
  },
  {},
  {},
  async (s) => {
    await s.session.query(
      [
        "Step 1: clean any stale marker files from a previous run.",
        \`  Run: rm -f ${MARKER_PATHS.join(" ")}\`,
        "",
        "Step 2: spawn three independent subagents using the Agent tool with run_in_background: true.",
        "  Each subagent must:",
        "    1. Run \`sleep 20\` via the Bash tool.",
        \`    2. Write a single line containing its own agent identifier into:\`,
        ...MARKER_PATHS.map((p, i) => \`       - subagent #${i + 1} → ${p}\`),
        "    3. Return.",
        "",
        "Step 3: end your turn IMMEDIATELY after dispatching all three subagents.",
        "  - Do NOT wait for them.",
        "  - Do NOT poll or summarize their progress.",
        "  - Use the Agent tool literally — three separate Agent tool calls, each with run_in_background: true.",
      ].join("\n"),
    );
    s.save(s.sessionId);
  },
);

void dispatch;
await ctx.stage(
  {
    name: "verify",
    description: "Confirm all three subagent marker files exist and are non-empty",
  },
  {},
  {},
  async (s) => {
    await s.session.query(
      [
        "The previous stage spawned three background subagents.",
        "",
        "Read each of the following files in turn:",
        ...MARKER_PATHS.map((p) => \`  - ${p}\`),
        "",
        "For each file, report:",
        "  - whether it exists",
        "  - the line of content it contains",
        "",
        "If any file is missing or empty, that means the harness advanced to this stage before the subagents finished.",
      ].join("\n"),
    );
    s.save(s.sessionId);
  },
);
```

**Variations / call-sites:**
- Dispatch pattern only: unique to this example

---

## Summary

The examples directory establishes **12 canonical patterns** across headless, HIL, and multi-agent flavors:

1. **defineWorkflow DSL** — structured input metadata (string, enum, text), chainable builder API (.for(), .run(), .compile())
2. **Multi-workflow registry** — createRegistry(), listWorkflows(), getName(), getInputSchema() for programmatic CLI composition
3. **Headless & visibility** — { headless: true } flag and extractAssistantText() utility for background execution
4. **Session handoff** — s.save() persists, s.transcript(handle) reads; dual return value (handle .result and .path)
5. **Agent polymorphism** — Claude .query(), Copilot .send(), OpenCode .client.session.prompt() with .for() selector
6. **Structured output** — Zod schema → JSON Schema → outputFormat config → validation via .safeParse()
7. **HIL detection** — AskUserQuestion / question tool availability per agent; stage execution holds until response
8. **Pane navigation** — SDK primitives (runWorkflow({ detach: true }), listSessions(), nextWindow(), gotoOrchestrator())
9. **CLI embedding** — Workflows as Commander subcommands; input schema auto-mapped to --<flag> options
10. **Loop logic** — Bounded iteration with .result callbacks driving control flow (early exit on "clean", state tracking)
11. **Local hosting** — hostLocalWorkflows([...]) for single-script deployments without separate workers
12. **Background gating** — run_in_background: true subagent dispatch with Stop-hook-driven waits

All patterns scale from headless (no TUI) through HIL (interactive user questions) to full multi-agent workflows across Claude, Copilot, and OpenCode backends. **Worker scripts** (*-worker.ts) are boilerplate Commander CLI wrappers over runWorkflow() with input parsing. **Package.json** scripts delegate to workers: "claude": "bun run claude-worker.ts".

## External References
<!-- Source: codebase-online-researcher sub-agent -->
# Partition 5 — `examples/` (3,435 LOC): External Research Decision

## Decision: External research is NOT required.

All three per-agent session APIs are exhaustively documented in the repository's own
`docs/` tree, and the example files themselves are unambiguous canonical references.
The signatures, option shapes, and return types can be read directly without fetching
any remote page. What follows is a structured extraction of the three SDK patterns
from first-party sources already in the repo.

---

## Per-Agent Session API Inventory (from `examples/` + `docs/`)

### @anthropic-ai/claude-agent-sdk

**Local docs:** `docs/claude-code/agent-sdk/sdk-references/typescript.md`,
`docs/claude-code/agent-sdk/guides/structured-output.md`

**Relevant behaviour:**

`s.session.query(prompt, options?)` is the single call site used in every Claude
example. It is a wrapper around the SDK-level `query()` async generator. The atomic
SDK awaits the entire generator and returns the collected `SDKMessage[]` array
(typed as the generator's yield type).

Key option fields seen in examples:

```typescript
// examples/structured-output-demo/claude/index.ts:45-52
const result = await s.session.query(buildPrompt(topic), {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  outputFormat: {
    type: "json_schema",
    schema: LANGUAGE_FACTS_JSON_SCHEMA,   // z.toJSONSchema(zodSchema, { target: "openapi-3.0" })
  },
});
// validated object is at: s.session.lastStructuredOutput
```

`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` is
the standard headless combination used whenever a stage is marked `headless: true`
(examples: `headless-test`, `structured-output-demo`, `hil-favorite-color-headless`).

After `query()`, the session Id is persisted with `s.save(s.sessionId)`. The string
sessionId is the artifact handed to the next stage's `s.transcript(handle)` call.

`extractAssistantText(result, 0)` (from `@bastani/atomic-sdk/workflows`) is the
helper used to pull the first assistant-turn text out of the returned message array.

**Where used (representative):**

| Call site | Notes |
|---|---|
| `examples/hello-world/claude/index.ts:53` | Plain `query(prompt)` — two turns in sequence |
| `examples/structured-output-demo/claude/index.ts:45` | `query(prompt, { outputFormat: { type:"json_schema", schema } })` |
| `examples/headless-test/claude/index.ts:27–108` | `query(prompt, { permissionMode, allowDangerouslySkipPermissions })` in parallel stages |
| `examples/review-fix-loop/claude/index.ts:69` | `query()` returns `SDKMessage[]`; `extractAssistantText()` reads verdict string |
| `examples/hil-favorite-color-headless/claude/index.ts:38` | headless query with disallowedTools injected by runtime |

---

### @github/copilot-sdk

**Local docs:** `docs/copilot-cli/sdk.md`

**Relevant behaviour:**

`s.session.send({ prompt })` is the only call used in every Copilot example. It
queues a message and resolves the message ID (not the response). Response content
is recovered via `s.session.getMessages()` which returns `SessionEvent[]`.

```typescript
// examples/hello-world/copilot/index.ts:51-53
await s.session.send({ prompt });
s.save(await s.session.getMessages());
```

`SessionEvent` is a discriminated union. The assistant text is extracted by
filtering for `{ type: "assistant.message" }` and reading `.data.content`. The
headless-test copilot index defines a local helper:

```typescript
// examples/headless-test/copilot/index.ts:6-13
function getAssistantText(messages: SessionEvent[]): string {
  return messages
    .filter(
      (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
        m.type === "assistant.message" && !m.data.parentToolCallId,
    )
    .map((m) => m.data.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
}
```

Structured output is achieved via `defineTool` (from `@github/copilot-sdk`), not a
response-format option. A Zod schema is passed as `parameters`; the SDK validates
tool-call arguments before firing `handler`:

```typescript
// examples/structured-output-demo/copilot/index.ts:46-54
const submitFacts = defineTool("submit_facts", {
  description: SUBMIT_TOOL_DESCRIPTION,
  parameters: LanguageFactsSchema,   // z.object({ ... })
  skipPermission: true,
  handler: async (data: LanguageFacts) => {
    captured = data;
    return "Facts submitted.";
  },
});
// tool passed in stageOptions.tools; prompt instructs model to call it
```

`CustomAgentConfig` (from `@github/copilot-sdk`) allows inline subagent definition
at session creation time, with a `tools` allowlist that is resolved against the live
tool registry (including SDK-registered tools):

```typescript
// examples/reviewer-tool-test/copilot/index.ts:72-79
const inlineReviewer: CustomAgentConfig = {
  name: "reviewer",
  tools: ["execute", "read", "search", "submit_review"],
  prompt: "...",
};
```

**Where used (representative):**

| Call site | Notes |
|---|---|
| `examples/hello-world/copilot/index.ts:51` | `session.send({ prompt })` + `getMessages()` |
| `examples/hil-favorite-color/copilot/index.ts:27–59` | Two-stage HIL with `send()` + transcript handoff via `prior.content` |
| `examples/structured-output-demo/copilot/index.ts:46–73` | `defineTool` with Zod schema; no `outputFormat` option |
| `examples/reviewer-tool-test/copilot/index.ts:61–106` | `defineTool` + `CustomAgentConfig` inline subagent |
| `examples/headless-test/copilot/index.ts:39–125` | `send()` + `getMessages()` in parallel stages; `SessionEvent` type import |

---

### @opencode-ai/sdk

**Local docs:** `docs/opencode/sdk.md`, `docs/opencode/server.md`

**Relevant behaviour:**

`s.client.session.prompt({ sessionID, parts, format? })` is the call used in every
OpenCode example. It is a direct HTTP call to the OpenCode server's `/session/{id}/prompt`
endpoint and returns `{ data: AssistantMessage }` synchronously (not a stream).

```typescript
// examples/hello-world/opencode/index.ts:54-58
const result = await s.client.session.prompt({
  sessionID: s.session.id,
  parts: [{ type: "text", text: prompt }],
});
s.save(result.data!);
```

The stage options third argument (the "provider options" slot) carries OpenCode-
specific session creation fields: `title` and `permission`. Every OpenCode example
passes a wildcard permission record:

```typescript
// examples/hello-world/opencode/index.ts:49-52 (stageOptions arg)
{
  title: "hello",
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
```

This is required — OpenCode sessions do not auto-approve tool calls.

Structured output uses a `format` parameter in the same `prompt()` call:

```typescript
// examples/structured-output-demo/opencode/index.ts:48-55
const result = await s.client.session.prompt({
  sessionID: s.session.id,
  parts: [{ type: "text", text: buildPrompt(topic) }],
  format: {
    type: "json_schema" as const,
    schema: LANGUAGE_FACTS_JSON_SCHEMA,
  },
});
// validated object: (result.data!.info as { structured?: unknown })?.structured
```

`result.data!` is the `AssistantMessage`. Its parts array (for text extraction) and
`info.structured` field (for structured output) are the two result surfaces used
across examples.

```typescript
// examples/headless-test/opencode/index.ts:7-11 (local helper)
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts.filter((p) => p.type === "text")
              .map((p) => (p as { type: string; text: string }).text)
              .join("\n");
}
// usage: extractResponseText(result.data!.parts)
```

**Where used (representative):**

| Call site | Notes |
|---|---|
| `examples/hello-world/opencode/index.ts:54` | `client.session.prompt({ sessionID, parts })` |
| `examples/hil-favorite-color/opencode/index.ts:30–76` | Two-stage; transcript via `prior.content`; each stage needs fresh `sessionID` |
| `examples/structured-output-demo/opencode/index.ts:48` | `prompt()` + `format: { type:"json_schema", schema }` |
| `examples/headless-test/opencode/index.ts:39–170` | Parallel stages; each awaits `prompt()` independently; no headless option needed (no interactive TUI) |
| `examples/parallel-hello-world/opencode/index.ts:42–118` | Fan-out/fan-in with `s.transcript()` handoff |

---

## Summary

External library documentation is not central to understanding the `examples/`
partition. The three session API surfaces are fully enumerated in the local `docs/`
tree and are directly visible in the example source files.

The rewrite implication is clear from the examples themselves: the three call shapes
that must collapse into a single pi-agent interface are:

1. **Claude** — `s.session.query(prompt, { permissionMode, outputFormat? })` → returns
   `SDKMessage[]`; structured output surfaces via `s.session.lastStructuredOutput`;
   session identity is a string ID passed to `s.save()`.

2. **Copilot** — `s.session.send({ prompt })` → fire-and-forget (returns message ID);
   response fetched separately via `s.session.getMessages()` → `SessionEvent[]`;
   structured output achieved only through `defineTool` with Zod `parameters`.

3. **OpenCode** — `s.client.session.prompt({ sessionID, parts, format? })` → returns
   `{ data: AssistantMessage }` directly; structured output via `format.type = "json_schema"`
   with result at `result.data.info.structured`; every session requires explicit
   `permission` records in the stage options.

The pi-agent unified interface must absorb these three divergent shapes into one
call — a single `session.run(prompt, options?)` or equivalent that normalises
prompt delivery, response retrieval, permission handling, and structured-output
extraction regardless of which underlying agent is in use.

No URLs were fetched. All findings derive from files within the repository:
`examples/**/*/index.ts`, `docs/claude-code/agent-sdk/`, `docs/copilot-cli/sdk.md`,
and `docs/opencode/sdk.md`.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
