I’m unable to write files with the available read-only tools in this session. Below is the content intended for:

`/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-existing-research-locator.md`

```md
# Existing Research Locator: fallbackModels, Context Overflow, Compaction, Workflows Stage Runner, Provider Errors, Model Fallback

Current date: 2026-07-07

## Related Tickets

No `research/tickets/` directory found.

## Related Research Documents

- 🟡 `research/docs/2026-05-14-pi-subagents-api-parity-for-atomic-workflows.md` - Maps pi-subagents API/runtime behavior to atomic-workflows; relevant to model option surfaces and direct task/chain/parallel execution.
- 🟡 `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md` - Analyzes local workflow SDK, `StageContext`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, model/thinking controls, compaction, and execution entrypoints.
- 🟡 `research/docs/2026-05-14-local-atomic-workflows-locator.md` - Locator for workflow SDK/tool files, including `stage-runner.ts`, foreground executor, extension wiring, and task/chain/parallel paths.
- 🟡 `research/docs/2026-05-12-extension-runs-workflows-test-surfaces.md` - Summarizes executable workflow runtime surfaces; directly mentions `createStageContext()` and lazy `AgentSession` creation in `stage-runner.ts`.
- 🟡 `research/docs/2026-05-12-workflow-authoring-registry-core.md` - Describes workflow authoring, `StageOptions`, `WorkflowRunContext`, `StageContext`, and pi `AgentSession`-like surface.
- 🟡 `research/docs/2026-05-11-pi-coding-agent-reference.md` - Canonical pi reference; includes `/compact`, auto-compaction, provider/model configuration, and `thinkingLevelMap`.
- 🔴 `research/docs/2026-03-01-opencode-auto-compaction.md` - Directly relevant to context overflow, `ContextOverflowError`, provider overflow parsing, and missing OpenCode auto-compaction recovery.
- 🔴 `research/docs/2026-02-11-workflow-sdk-implementation.md` - Older workflow SDK research covering graph execution, context monitoring thresholds, retries, model config, and workflow/subagent execution.

## Related Specs

- 🟡 `specs/2026-05-14-workflow-sdk-fallback-models.md` - Primary spec for workflow-native `fallbackModels`; covers retryable provider/model failures, attempted model metadata, stage runner fallback loop, and stripping workflow-only options.
- 🟡 `specs/2026-05-14-workflow-sdk-pi-subagents-api-parity.md` - API parity spec for workflow direct execution; relevant to model option propagation and direct task/chain/parallel surfaces.
- 🔴 `specs/2026-03-02-opencode-auto-compaction.md` - Technical design for OpenCode auto-compaction; covers `ContextOverflowError` detection, `summarize()` recovery, provider errors, and TUI compaction events.
- 🔴 `specs/2026-02-11-workflow-sdk-implementation.md` - Formal spec for custom tools, sub-agents, graph execution, and model fallback in workflow node factories.
- 🔴 `specs/2026-01-31-sdk-migration-and-graph-execution.md` - Older SDK migration spec; discusses context compaction across Claude/OpenCode/Copilot and context overflow risk in Ralph loops.

## Related Discussions / Notes

No `research/notes/` directory found.

## Summary

Total: 13 relevant documents found  
- 6 🟡 Moderate  
- 7 🔴 Aged

Most directly relevant newer document:  
`specs/2026-05-14-workflow-sdk-fallback-models.md`

Most directly relevant context-overflow/compaction documents:  
`research/docs/2026-03-01-opencode-auto-compaction.md`  
`specs/2026-03-02-opencode-auto-compaction.md`
```