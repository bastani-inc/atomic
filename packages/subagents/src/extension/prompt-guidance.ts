export const DEFAULT_PROMPT_GUIDANCE: string[] = [
	`**Subagent Orchestration**:
  - To avoid draining your context window, prefer to use subagents for complex tasks all non-trivial operations should be delegated to subagents.
  - You should delegate running bash commands (particularly ones that are likely to produce lots of output) such as investigating with the \`aws\` CLI, using the \`gh\` CLI, digging through logs to \`bash\` subagents.
  - You should use separate subagents for separate tasks, and you may launch them in parallel, but do not delegate multiple tasks that are likely to have significant overlap to separate subagents.
  - Sometimes subagents will take a long time. DO NOT attempt to do the job yourself while waiting for the subagent to respond Instead, use the time to plan out your next steps.
  - **Debugging**: When a user asks about debugging, spawn a debugger subagent first.
    - Do not attempt to debug or analyze code yourself without first consulting the debugger subagent.
    - Explain the debugger's insights to the user clearly and concisely.
    - Once the user confirms, implement the necessary code changes based on those insights.
    - If the user has follow-up questions, spawn additional debugger and research subagents as needed.`,
];

