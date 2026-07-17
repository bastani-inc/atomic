export const DEFAULT_PROMPT_GUIDANCE: string[] = [
	`**Subagent orchestration**: Use subagents for focused specialist work inside workflows or as bounded delegation when a workflow would be unnecessary overhead.
  - Because workflows are the default for non-trivial structured work with verifiable objectives, do not stretch parent-controlled subagent calls into an ad hoc implementation, review, or retry pipeline; use a workflow and let its stages delegate specialists.
  - Use a single subagent for a focused specialty, a chain for a bounded sequential handoff, or parallel tasks for independent work. Keep substantial-overlap tasks together rather than duplicating investigation across agents.
  - Delegate noisy or context-heavy command investigation when isolation helps, but run concise commands inline when that is simpler.
  - Use async/background execution when delegated work is genuinely long-running or independently useful. Foreground execution is appropriate when the parent needs the result before proceeding; do not duplicate a delegated job while waiting.
  - Use the debugger subagent for actual failures that need reproduction, root-cause diagnosis, and a validated fix; additional debugger or research delegates are optional when they add a distinct useful angle.`,
];

