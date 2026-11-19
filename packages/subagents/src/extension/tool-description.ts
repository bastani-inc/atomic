export const SUBAGENT_TOOL_DESCRIPTION = `Delegate bounded specialist work to subagents or manage agent definitions while the parent remains in control.
EXECUTION (use exactly ONE mode):
• Execution calls always start non-interactively, and every child runs in the background: the call returns once each child is admitted, with its task id, and the child reports by a completion notice when it ends.
• Before executing, use { action: "list" } to inspect configured agents. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task?, progress? } - one focused task; progress:true maintains a run-scoped progress.md under isolated artifact storage without writing it into the child cwd (separate from includeProgress, which only returns runtime telemetry); omit task for self-contained agents
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?,worktree?}, ...], concurrency?: number, worktree?: true } - independent concurrent tasks (worktree: true isolates each task in a temporary git worktree, removed afterwards)
• Named worktree: worktree: { branch, base?, path? } on a SINGLE call, a PARALLEL call, or a task runs the child in that branch's worktree (default path .atomic/worktrees/<branch>; a new branch starts at base, else the upstream, else HEAD). It is created before the child starts, reused when the branch is already checked out at that path, refused when the branch is checked out elsewhere or the path holds something else, and never removed. Prefer it to creating a worktree with git in the same turn: tool calls in one message run at the same time, so the launch's cwd may not exist yet.
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" })
• group (string | true) sets the intercom group for spawned children so same-group subagents can intercom each other but stay isolated from other groups. Boolean true or the trimmed, case-insensitive string sentinel "true"/"auto" auto-generates one shared UUID group per parallel set; those names are reserved and cannot be literal group names. Defaults to the current session/stage's group (subagents inherit their launching stage's group). Only applied when the child has intercom access; contact_supervisor still reaches the supervisor across groups.
MANAGEMENT (use action field, omit agent/task/tasks):
• { action: "models" } - inspect configured models, their fullId and availableThinkingLevels
• { action: "list" } - discover executable agents
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
CONTROL:
• { action: "wait", id: "<task id>", budgetMs?: number } - wait for a launched child to finish, up to budgetMs (the owner's budget when omitted); the wait also ends when the user presses Esc, and the child keeps running either way
• { action: "status", id: "..." } - inspect an in-process run by id or prefix; a paused or quit child shows as paused · awaiting resume with its resume call, and { action: "status" } lists every such child
• { action: "pause", id: "..." } / { action: "pause", all: true } - stop a running child and hold its queued messages until resume; it stays resumable
• { action: "quit", id: "..." } / { action: "quit", all: true } - stop a child gracefully (including a paused one), as a workflow quit does: it is paused · awaiting resume, not ended, and stays resumable
• { action: "resume", id: "...", message?: "..." } - continue a paused, quit, interrupted, completed or failed child from its own session under the same id and Intercom name; message is delivered once as its next prompt, otherwise it continues where it left off. Children cancelled for good (owner or batch cancellation, the removed kill action), ended with their workflow stage (quit ones included), or reported gone cannot be resumed
• id accepts the child id (<runId>:<index>), its task id, its Intercom name, or the run id of a single-child run. kill and interrupt were removed: use quit`;
