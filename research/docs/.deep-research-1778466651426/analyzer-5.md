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
