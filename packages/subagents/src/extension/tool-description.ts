export const SUBAGENT_TOOL_DESCRIPTION = `Delegate bounded specialist work to subagents or manage agent definitions while the parent remains in control.
EXECUTION (use exactly ONE mode):
• Execution calls always start non-interactively.
• Before executing, use { action: "list" } to inspect configured agents. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task?, progress? } - one focused task; progress:true maintains a run-scoped progress.md under isolated artifact storage without writing it into the child cwd (separate from includeProgress, which only returns runtime telemetry); omit task for self-contained agents
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - independent concurrent tasks (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" })
• group (string | true) sets the intercom group for spawned children so same-group subagents can intercom each other but stay isolated from other groups. Boolean true or the trimmed, case-insensitive string sentinel "true"/"auto" auto-generates one shared UUID group per parallel set; those names are reserved and cannot be literal group names. Defaults to the current session/stage's group (subagents inherit their launching stage's group). Only applied when the child has intercom access; contact_supervisor still reaches the supervisor across groups.
MANAGEMENT (use action field, omit agent/task/tasks):
• { action: "list" } - discover executable agents
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
CONTROL:
• { action: "status", id: "..." } - inspect an in-process run by id or prefix; a paused or quit child shows as paused · awaiting resume with its resume call, and { action: "status" } lists every such child
• { action: "pause", id: "..." } / { action: "pause", all: true } - stop a running child and hold its queued messages until resume; it stays resumable
• { action: "quit", id: "..." } / { action: "quit", all: true } - stop a child gracefully (including a paused one), as a workflow quit does: it is paused · awaiting resume, not ended, and stays resumable
• { action: "resume", id: "...", message?: "..." } - continue a paused, quit, interrupted, completed or failed child from its own session under the same id and Intercom name; message is delivered once as its next prompt, otherwise it continues where it left off. Children cancelled for good (owner or batch cancellation, the removed kill action), ended with their workflow stage (quit ones included), or reported gone cannot be resumed
• id accepts the child id (<runId>:<index>), its task id, its Intercom name, or the run id of a single-child run. kill and interrupt were removed: use quit`;
