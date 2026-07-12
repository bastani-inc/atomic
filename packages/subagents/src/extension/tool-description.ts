import { APP_NAME } from "@bastani/atomic";

export const SUBAGENT_TOOL_DESCRIPTION = `Delegate bounded specialist work to subagents or manage agent definitions while the parent remains in control.
EXECUTION (use exactly ONE mode):
• Execution calls always start non-interactively.
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task?, progress? } - one focused task; progress:true maintains a run-scoped progress.md under isolated artifact storage without writing it into the child cwd (separate from includeProgress, which only returns runtime telemetry); omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - bounded sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - independent concurrent tasks (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" })
• async:true is selective for genuinely long-running/background work; foreground is appropriate when the parent needs the result before proceeding
CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/${APP_NAME}-subagents-<scope>/chain-runs/abc123/)
Example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }
MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• Use chainName for chain operations; packaged chains also use dotted runtime names
CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "resume", id: "...", message: "...", index?: 0 } - follow up with a live async child or revive a completed async/foreground child from its session
DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom`;
