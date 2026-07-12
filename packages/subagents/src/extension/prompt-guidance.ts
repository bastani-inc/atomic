export const DEFAULT_PROMPT_GUIDANCE: string[] = [
	`**Subagent orchestration**: Use subagents selectively for bounded specialist delegation while the parent remains in control.
  - Keep interactive, exploratory, conceptual, and conversation-led work inline when direct discussion and user steering are more useful than delegation.
  - Use a single subagent for a focused specialty, a chain for a bounded sequential handoff, or parallel tasks for independent work. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow.
  - Delegate noisy or context-heavy command investigation when isolation helps, but run concise commands inline when that is simpler. Do not split work with substantial overlap across independent subagents.
  - Use async/background execution selectively for genuinely long-running or independently useful delegated work. Foreground execution is appropriate when the parent needs the result before proceeding; do not duplicate a delegated job while waiting.
  - For clearly delegated, well-defined autonomous jobs that are likely long-running/background-oriented or materially need durable stages, checkpoints, resumability, human input, gates, retries, or bounded loops, prefer an appropriate workflow rather than stretching subagent orchestration into an ad hoc workflow.
  - Debug conceptual questions or exploratory analysis inline when appropriate. Use the debugger subagent for actual failures that need reproduction, root-cause diagnosis, and a validated fix; additional debugger or research delegates are optional when they add a distinct useful angle.`,
];

