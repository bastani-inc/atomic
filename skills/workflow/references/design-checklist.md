# Workflow Design Checklist

Use this before implementing or shipping a non-trivial workflow.

## 1. Purpose and fit

- What concrete outcome should the workflow produce?
- Is the task naturally multi-stage, parallel, resumable, or reusable?
- Which parts require LLM judgment and which are deterministic TypeScript?
- What should explicitly be out of scope?

## 2. Inputs

- Declare every user-provided value as an input.
- Pick the narrowest schema type: `text`, `string`, `number`, `boolean`, or `select`.
- Add useful descriptions; set defaults only when safe.
- Validate risky input combinations before starting expensive stages.

## 3. Stage decomposition

For each planned stage, write:

- stage name
- whether it is sequential, parallel, or conditional
- the LLM question/prompt it answers
- input context required
- output artifact/result shape
- model/thinking/tool/MCP needs
- failure mode and retry/fallback behavior

Avoid stages that only do filesystem, parsing, git, or formatting work.

## 4. Information flow

For every edge between stages, specify the handoff mechanism:

- `previous` / `{previous}` for concise textual output
- structured return values for typed summaries
- files/artifacts for large outputs
- `reads` for explicit file preload
- `output` / `outputMode` for durable result files
- `sessionDir` for debug/session capture

Ask: "If the downstream stage only receives this handoff, can it succeed?"

## 5. Context engineering

Load `context-engineering.md` and relevant detailed references. At minimum consider:

- prompt placement and progressive disclosure
- transcript compression for large handoffs
- context degradation in loops
- file-based coordination for large artifacts
- multi-agent handoff protocols
- quality gates and evaluator stages

## 6. Control flow

- Use `ctx.chain` for dependent steps.
- Use `ctx.parallel` for independent branches.
- Use `concurrency` limits for large fan-outs.
- Use `failFast` deliberately where available.
- Use loops only with clear bounds and termination criteria.
- Use `fallbackModels` for critical expensive stages when model availability is uncertain.

## 7. User experience

- Name stages so they make sense in workflow UI/status.
- Return a compact structured output at the end.
- Save important artifacts with stable paths.
- Surface HIL/attention states promptly.
- Include enough progress and output for resumed/inspected runs.

## 8. Final sanity pass

- Confirm the workflow definition exports `defineWorkflow(...).run(...).compile()`.
- Confirm every required input is declared and described.
- Confirm every stage name is user-readable in `/workflow status` and the graph UI.
- Confirm the workflow uses a supported surface: `/workflow`, the `workflow` tool, or explicit `runWorkflow(...)` objects.
