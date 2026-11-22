import { type Static, Type } from "@bastani/atomic-ai";
import { Text } from "@bastani/atomic-tui";
import type { SessionEntry } from "../../session-manager.ts";
import type { LazyBuiltinController, LazyBuiltinSpec } from "../lazy-builtin.js";
import type { ToolDefinition, ToolScriptAccess } from "../types.ts";

const MAX_PARALLEL_TASKS = 1000;
const SUBAGENT_ACTIONS = [
	"models",
	"list",
	"get",
	"create",
	"update",
	"delete",
	"status",
	"wait",
	"pause",
	"resume",
	"quit",
] as const;
const REMOVED_SUBAGENT_ACTIONS = ["kill", "interrupt"] as const;
const SUBAGENT_SCRIPT_ACTIONS: readonly string[] = [
	"list",
	"get",
	"models",
	"status",
	"wait",
	"pause",
	"resume",
	"quit",
];

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SUBAGENT_NOTIFY_TYPE = "subagent-notify";
const SUBAGENT_LATE_TOOL_RESULT_TYPE = "subagent-late-tool-result";
const SUBAGENT_RESUME_NOTE_TYPE = "subagent-resume-note";
const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
const SUBAGENT_CHILD_RECORD_TYPE = "subagent-child";

const SUBAGENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	SLASH_RESULT_TYPE,
	SUBAGENT_NOTIFY_TYPE,
	SUBAGENT_LATE_TOOL_RESULT_TYPE,
	SUBAGENT_RESUME_NOTE_TYPE,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
]);

const INTERCOM_CONNECTED_EVENT = "intercom:connected";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const SUBAGENT_COMPLETE_EVENT = "subagent:complete";
const SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT = "subagent:await-child-restoration";
const SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT = "subagent:list-intercom-children";
const SUBAGENT_FINISHED_ASKS_EVENT = "subagent:finished-asks";
const SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT = "subagent:restored-intercom-peers";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

const INTERCEPTED_BUS_EVENTS: readonly string[] = [
	INTERCOM_CONNECTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_COMPLETE_EVENT,
	SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT,
	SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT,
	SUBAGENT_FINISHED_ASKS_EVENT,
	SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
];

const MANAGED_EVENTS: readonly string[] = ["session_recovery_restore"];

const SUBAGENT_TOOL_DESCRIPTION = `Delegate bounded specialist work to subagents or manage agent definitions while the parent remains in control.
EXECUTION (use exactly ONE mode):
• Execution calls always start non-interactively, and every child runs in the background: the call returns once each child is admitted, with its task id, and the child reports by a completion notice when it ends.
• Before executing, use { action: "list" } to inspect configured agents. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task?, progress? } - one focused task; progress:true maintains a run-scoped progress.md under isolated artifact storage without writing it into the child cwd (separate from includeProgress, which only returns runtime telemetry); omit task for self-contained agents
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?,worktree?}, ...], concurrency?: number, worktree?: true } - independent concurrent tasks (worktree: true isolates each task in a temporary git worktree, removed afterwards)
• Named worktree: worktree: { branch, base?, path? } on a SINGLE call, a PARALLEL call, or a task runs the child in that branch's worktree (default path .atomic/worktrees/<branch>; a new branch starts at base, else the upstream, else HEAD). It is created before the child starts, reused when the branch is already checked out at that path, refused when the branch is checked out elsewhere or the path holds something else, and never removed. Prefer it to creating a worktree with git in the same turn: tool calls in one message run at the same time, so the launch's cwd may not exist yet.
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" }). Use "fork" when the child needs this conversation: it continues it as sent, so on the same model and thinking level its first request is read from this session's prompt cache, and only its role and task are new. Use "fresh" for independent work: a smaller context with only the task. A fork carries the whole conversation, including the project context and skills this session was sent; its own tool policy still applies to the tools it calls.
• group (string | true) sets the intercom group for spawned children so same-group subagents can intercom each other but stay isolated from other groups. Boolean true or the trimmed, case-insensitive string sentinel "true"/"auto" auto-generates one shared UUID group per parallel set; those names are reserved and cannot be literal group names. Defaults to the launching session's group. Only applied when the child has intercom access; contact_supervisor still reaches the supervisor across groups.
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
• { action: "quit", id: "..." } / { action: "quit", all: true } - stop a child gracefully (including a paused one): it is paused · awaiting resume, not ended, and stays resumable
• { action: "resume", id: "...", message?: "..." } - continue a paused, quit, interrupted, completed or failed child from its own session under the same id and Intercom name; message is delivered once as its next prompt, otherwise it continues where it left off. Children cancelled for good (owner or batch cancellation, the removed kill action) or reported gone cannot be resumed
• id accepts the child id (<runId>:<index>), its task id, its Intercom name, or the run id of a single-child run. kill and interrupt were removed: use quit`;

const DEFAULT_PROMPT_GUIDANCE: string[] = [
	`**Subagent orchestration**: Delegate bounded specialist work to subagents. For multi-step work with verifiable objectives, coordinate children from codemode: record their task ids and outstanding work with store(), and continue from their completion notices. The children persist; the script does not replay.
  - Honor requests to work inline. Keep appropriate testing, review and evidence inline, without hidden delegation or pressure to reapprove. When switching to inline work, account for children already launched and their results so you don't duplicate their work. Do not claim completed work was undone.
  - Use a single subagent for a focused specialty or parallel tasks for independent work. Keep substantial-overlap tasks together rather than duplicating investigation across agents.
  - Keep immediately blocking work local unless specialist expertise, context isolation, or an explicit user request justifies delegation. Delegate independent work that can usefully overlap your own next steps; do not spawn a child merely to wait immediately. Delegate noisy or context-heavy command investigation when isolation helps, but run concise commands inline when that is simpler.
  - Subagents always run in the background: a launch returns once each child is admitted, with its task id, while the child continues, and its completion notice arrives when it ends. In codemode, await tools.subagent({ agent, task }) or tools.subagent({ tasks }); save its task IDs and continue independent work. The children outlive the script. A returned launch never means the task stopped. Do not duplicate delegated work; wait for the existing task or its completion notice. The UI lists each running subagent below the prompt and in /tasks, where the user can open its chat and message it.
  - When the next step needs a child's result, wait for it with subagent({ action: "wait", id }) or end your turn and continue when its completion notice arrives. A wait ends when it reaches its budget or the user presses Esc, and the child keeps running either way. Wait for terminal completion before starting dependent work. Running in the background does not bypass tool permissions, delegation boundaries, or owner lifetime.
  - Continue useful independent work after spawning without duplicating the child's task. Wait when its result becomes a dependency; otherwise rely on completion notices. Avoid repeated short waits or status polls. Omit the wait budget to use owner policy unless a concrete responsiveness need calls for an override.
  - Use the debugger subagent for actual failures that need reproduction, root-cause diagnosis, and a validated fix; additional debugger or research delegates are optional when they add a distinct useful angle.
  - Let each named agent use its declared model and fallback policy: omit the explicit model argument unless the user requests an exact model or a documented task requirement needs one, and record the reason for any override before launch. Do not choose an ad hoc model merely for diversity.
  - \`model: "auto"\`, which the builtin agents declare, runs the user's configured default model at its default thinking level, or the current session's model when no default is configured; an agent that declares no model runs the current session's model. When a task needs a specific model, use subagent({ action: "models" }) to inspect the configured catalog. Pin only a returned fullId and only append a thinking level listed for that entry. If the catalog tool is unavailable, the catalog is empty, or no catalog model fits, leave the child unpinned and state the limitation rather than inventing a model. Do not inspect credentials or infer why a model is absent.
  - Children inherit the launching session's group across single, parallel, and follow-up work. Set group: true for a new group or use an explicit name to coordinate a team. Keep contact_supervisor available for cross-group escalation.
  - Default to peer-to-peer (swarm) coordination; the supervisor is not a message relay. There are no limits on communication between agents; it is encouraged whenever you need to. Same-group children discover each other with intercom list and send/ask each other directly to broadcast findings, debate, claim work, hand off paths and reproductions, and self-organize. contact_supervisor is for supervisor decisions, and each child still returns its own result. Scale the swarm with the task: for very complex work or when the user asks for heavy parallelism, run hundreds or thousands of agents that self-organize into teams (named Intercom groups and parallel sets launched by the parent) and coordinate peer-to-peer like an organization.`,
];

const SkillOverride = Type.Unsafe({
	anyOf: [{ type: "array", items: { type: "string" } }, { type: "boolean" }, { type: "string" }],
	description:
		"Skill name(s) to inject (comma-separated), array of strings, or boolean (false disables, true uses default)",
});

const OutputOverride = Type.Unsafe({
	anyOf: [{ type: "string" }, { type: "boolean" }],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description:
		"Return saved output inline (default) or only a concise file reference. file-only requires output to be a path.",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [{ type: "array", items: { type: "string" } }, { type: "boolean" }],
	description: "Files to read before running (array of filenames), or false to disable",
});

const RootReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean", enum: [false] },
	],
	description:
		"Files for a single agent to read before running, or false to disable. Relative paths resolve against the effective child cwd.",
});

const MaxOutputSchema = Type.Object(
	{
		bytes: Type.Optional(Type.Number()),
		lines: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

function heartbeatSchema(scope: string) {
	return Type.Number({
		minimum: 0,
		description: `Heartbeat cadence in ms for ${scope} while it runs (default 15 min; 0 disables; min 60000).`,
	});
}

const GroupSchema = Type.Union([Type.String(), Type.Boolean()], {
	description:
		"Intercom group for spawned children. A named string joins that group; boolean `true` or the trimmed, case-insensitive string sentinel `true`/`auto` auto-generates one shared UUID group per parallel set. The names `true` and `auto` are reserved; use a different literal group name. Defaults to the launching session's group. Only applied when the child has intercom access; contact_supervisor still reaches the supervisor across groups.",
});

const NamedWorktreeSchema = Type.Object(
	{
		branch: Type.String({ description: "Branch to check out in the worktree; created when it does not exist." }),
		base: Type.Optional(
			Type.String({
				description: "Where a new branch starts (default: the current branch's upstream, or HEAD).",
			}),
		),
		path: Type.Optional(
			Type.String({ description: "Worktree directory (default: .atomic/worktrees/<branch> in the repository)." }),
		),
	},
	{
		additionalProperties: false,
		description:
			"Run in a named git worktree, created before the child starts or reused when this branch is already checked out at this path. Refused before launch when the branch is checked out elsewhere or the path holds something else. The worktree and branch are yours: never removed.",
	},
);

const TaskItem = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(NamedWorktreeSchema),
	count: Type.Optional(
		Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." }),
	),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(
		Type.Boolean({
			description:
				"Enable tracking in the run's shared progress.md under isolated artifact storage, never in the task cwd",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Concrete model override, or 'auto' for the user's default model (the current session's model when none is configured).",
		}),
	),
	skill: Type.Optional(SkillOverride),
	group: Type.Optional(GroupSchema),
	heartbeatMs: Type.Optional(heartbeatSchema("this task")),
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" }),
	),
	needsAttentionAfterMs: Type.Optional(
		Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" }),
	),
	activeNoticeAfterMs: Type.Optional(
		Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" }),
	),
	activeNoticeAfterTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Optional active-long-running notice threshold by assistant turns (disabled by default)",
		}),
	),
	activeNoticeAfterTokens: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Optional active-long-running notice threshold by total tokens (disabled by default)",
		}),
	),
	failedToolAttemptsBeforeAttention: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)",
		}),
	),
	progressScores: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Optional injected progress scores used only to raise attention priority; never a run outcome.",
		}),
	),
	notifyOn: Type.Optional(
		Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
			description:
				"Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
		}),
	),
	notifyChannels: Type.Optional(
		Type.Array(Type.String({ enum: ["event", "intercom"] }), {
			description: "Notification channels to use when available. Defaults to event and intercom.",
		}),
	),
});

const SubagentParams = Type.Object(
	{
		budgetMs: Type.Optional(
			Type.Number({
				description:
					"action='wait' only: how long to wait for the task, in milliseconds; omitted uses the owner's budget. The task keeps running when the wait ends.",
			}),
		),
		heartbeatMs: Type.Optional(heartbeatSchema("each child; a task's own wins")),
		agent: Type.Optional(
			Type.String({ description: "Agent name (SINGLE mode) or target for management get/update/delete" }),
		),
		task: Type.Optional(Type.String({ description: "Task (SINGLE mode, optional for self-contained agents)" })),
		action: Type.Optional(
			Type.String({
				enum: [...SUBAGENT_ACTIONS],
				description:
					"Management/control action; models lists the configured model catalog. Omit for execution mode. pause/resume/quit control a launched child; kill and interrupt were removed (use quit).",
			}),
		),
		id: Type.Optional(
			Type.String({
				description:
					"Target for action='status' (run id or prefix), 'wait' (task id), or 'pause'/'resume'/'quit' (child id <runId>:<index>, its task id, Intercom name, or a single-child run id).",
			}),
		),
		runId: Type.Optional(
			Type.String({
				description: "Legacy alias of id for status and pause/resume/quit. Prefer id for new calls.",
			}),
		),
		message: Type.Optional(
			Type.String({
				description:
					"Free-form steer for action='resume', delivered once as the child's next prompt. Without it the child continues where it left off.",
			}),
		),
		all: Type.Optional(
			Type.Boolean({
				description:
					"With action='pause' or 'quit', act on every running child this session launched (quit also covers paused children; every quit child stays resumable). Not valid with resume or id.",
			}),
		),
		config: Type.Optional(
			Type.Unsafe({
				anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
				description: `Agent config for create/update. Agent: name, package (optional namespace; runtime name becomes package.name), description, scope ('user'|'project', default 'user'), systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext ('fresh'|'fork'), model, tools (comma-separated), extensions (comma-separated), skills (comma-separated), thinking, output, reads, progress. String values must be valid JSON.`,
			}),
		),
		tasks: Type.Optional(
			Type.Array(TaskItem, {
				description: `PARALLEL mode: [{agent, task, count?, output?, outputMode?, reads?, progress?}, ...]. Maximum tasks after count expansion is configured by parallel.maxTasks (default ${MAX_PARALLEL_TASKS}).`,
			}),
		),
		concurrency: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or 1000.",
			}),
		),
		group: Type.Optional(GroupSchema),
		worktree: Type.Optional(
			Type.Union([Type.Boolean(), NamedWorktreeSchema], {
				description:
					"true: create isolated, temporary git worktrees for each parallel task " +
					"(requires clean git state; per-worktree diffs included in output; removed afterwards). " +
					"{ branch, base?, path? }: run the single agent, or each task without its own, in that named worktree, " +
					"created before the child starts and never removed.",
			}),
		),
		context: Type.Optional(
			Type.String({
				enum: ["fresh", "fork"],
				description:
					"'fresh' or 'fork' to branch from parent session. If omitted, any requested agent with defaultContext: 'fork' makes the whole invocation forked; otherwise the default is 'fresh'.",
			}),
		),
		agentScope: Type.Optional(
			Type.String({
				description:
					"Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)",
			}),
		),
		cwd: Type.Optional(Type.String()),
		maxOutput: Type.Optional(MaxOutputSchema),
		artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
		includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
		share: Type.Optional(
			Type.Boolean({ description: "Has no effect: nothing is uploaded or shared (default: false)" }),
		),
		sessionDir: Type.Optional(
			Type.String({
				description:
					"Keep fresh (not forked) subagents' sessions as JSONL files under this directory instead of the launching session's store",
			}),
		),
		control: Type.Optional(ControlOverrides),
		output: Type.Optional(
			Type.Unsafe({
				anyOf: [{ type: "string" }, { type: "boolean" }],
				description:
					"Output file for single agent (string), or false to disable. Relative paths resolve against cwd.",
			}),
		),
		outputMode: Type.Optional(OutputModeOverride),
		reads: Type.Optional(RootReadsOverride),
		progress: Type.Optional(
			Type.Boolean({
				description:
					"Enable run-scoped progress.md tracking for a single agent under isolated artifact storage, without writing progress.md into the child cwd. This controls the child-maintained file; includeProgress separately controls whether detailed runtime telemetry is returned.",
			}),
		),
		skill: Type.Optional(SkillOverride),
		model: Type.Optional(
			Type.String({
				description:
					"Concrete model override, or 'auto' for the user's default model (the current session's model when none is configured).",
			}),
		),
	},
	{ additionalProperties: false },
);

const str = Type.String();
const optionalStr = Type.Optional(str);
const resumeCall = Type.Optional(Type.Object({ action: Type.Literal("resume"), id: str }));
const identityFields = { childId: str, agent: str, taskId: optionalStr, intercomTarget: optionalStr };
const summaryFields = {
	name: str,
	description: str,
	scope: str,
	package: optionalStr,
	executable: Type.Boolean(),
	model: optionalStr,
	defaultContext: optionalStr,
};

const subagentScriptAccess: ToolScriptAccess<{
	action?: string;
	id?: string;
	all?: boolean;
	runId?: string;
	budgetMs?: number;
}> = {
	description: `Launch specialists with {agent, task?} or {tasks:[{agent,task,count?}, ...], concurrency?}. Launch returns ordered tasks at admission, not completion. Keep childId for resume after restart, taskId for wait, and intercomTarget for peer messages. A child keeps running after the script ends and notifies the owning session.
Inspect definitions with list/get and the configured model catalog with models. status lists owned children; pass id for one. wait takes a task id and optional budgetMs (owner budget, default 30000); ending the wait never stops the child. pause/quit take id or all:true for this session; resume takes id and optional message. create/update/delete are model-only.`,
	outputSchema: Type.Union([
		Type.Object({
			action: Type.Literal("launch"),
			tasks: Type.Array(
				Type.Union([
					Type.Object({
						...identityFields,
						taskId: str,
						state: Type.Union([Type.Literal("admitted"), Type.Literal("queued")]),
					}),
					Type.Object({ agent: str, state: Type.Literal("refused"), reason: str }),
				]),
			),
		}),
		Type.Object({
			action: Type.Literal("wait"),
			taskId: str,
			outcome: Type.Union([Type.Literal("running"), Type.Literal("settled"), Type.Literal("stopped-waiting")]),
			childId: optionalStr,
			resumeCall,
			worktreeNote: optionalStr,
			result: Type.Optional(
				Type.Object({ status: str, output: optionalStr, outputPath: optionalStr, reason: optionalStr }),
			),
		}),
		Type.Object({
			action: Type.Literal("status"),
			children: Type.Array(
				Type.Object({
					...identityFields,
					state: str,
					resumable: Type.Boolean(),
					worktreeNote: optionalStr,
					resumeCall,
				}),
			),
		}),
		Type.Object({
			action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("quit")]),
			children: Type.Array(Type.Object({ ...identityFields, state: str })),
			worktreeNotes: Type.Optional(Type.Array(str)),
		}),
		Type.Object({ action: Type.Literal("list"), agents: Type.Array(Type.Object(summaryFields)) }),
		Type.Object({
			action: Type.Literal("get"),
			definitions: Type.Array(
				Type.Object({
					...summaryFields,
					systemPrompt: str,
					systemPromptMode: str,
					inheritProjectContext: Type.Boolean(),
					inheritSkills: Type.Boolean(),
					tools: Type.Optional(Type.Array(str)),
					mcpDirectTools: Type.Optional(Type.Array(str)),
					fallbackModels: Type.Optional(Type.Array(str)),
					skills: Type.Array(str),
				}),
			),
		}),
		Type.Object({
			action: Type.Literal("models"),
			models: Type.Array(
				Type.Object({
					provider: str,
					id: str,
					fullId: str,
					isCurrent: Type.Boolean(),
					availableThinkingLevels: Type.Array(str),
				}),
			),
		}),
	]),
	refuse({ action, id, all, runId, budgetMs }) {
		if (action !== undefined && !SUBAGENT_SCRIPT_ACTIONS.includes(action))
			return `subagent "${action}" is model-only: call the subagent tool directly, not from a script.`;
		if (runId !== undefined) return "Use id instead of runId in subagent scripts.";
		if (all && action !== "pause" && action !== "quit") return "Only pause and quit accept all: true.";
		if (
			(action === "wait" || action === "resume" || ((action === "pause" || action === "quit") && !all)) &&
			!id?.trim()
		)
			return `subagent "${action}" requires a child or task id.`;
		if (action === "wait" && budgetMs !== undefined && (!Number.isSafeInteger(budgetMs) || budgetMs < 0))
			return "budgetMs must be a non-negative integer.";
		return undefined;
	},
};

const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";
const WARN_KEY = "__atomicWarnDeprecation";
const REMOVED_LAUNCH_FIELDS = ["taskNeeds", "modelConstraints"] as const;

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string, notice: { once?: string }) => void;
	[WARN_KEY]?: (message: string, options?: { once?: string }) => void;
};

function warnRemovedRoutingOption(option: string): void {
	const message = `"${option}" is ignored: automatic model routing was removed, so "auto" runs your default model and provider or model restrictions no longer limit "auto" or any fallback model.`;
	const registry = globalThis as DeprecationRegistry;
	const warn = registry[WARN_KEY];
	if (warn !== undefined) {
		warn(message, {});
		return;
	}
	registry[EMITTED_KEY] ??= new Set<string>();
	if (registry[EMITTED_KEY].has(message)) return;
	registry[EMITTED_KEY].add(message);
	const sink = registry[SINK_KEY];
	if (sink !== undefined) sink(message, {});
	else console.warn(`Deprecation warning: ${message}`);
}

function withoutRemovedLaunchFields<T extends object>(value: T): T {
	if (!REMOVED_LAUNCH_FIELDS.some((field) => Object.hasOwn(value, field))) return value;
	for (const field of REMOVED_LAUNCH_FIELDS) if (Object.hasOwn(value, field)) warnRemovedRoutingOption(field);
	const removed: ReadonlySet<string> = new Set(REMOVED_LAUNCH_FIELDS);
	return Object.fromEntries(Object.entries(value).filter(([key]) => !removed.has(key))) as T;
}

function withoutLegacyWait<T extends object>(args: T): T {
	if (!Object.hasOwn(args, "wait")) return args;
	return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "wait")) as T;
}

function prepareSubagentArguments(args: unknown): Static<typeof SubagentParams> {
	const action = typeof args === "object" && args !== null ? (args as { action?: string }).action : undefined;
	if (action !== undefined && (REMOVED_SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
		throw new Error(
			`The subagent action "${action}" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.`,
		);
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args as Static<typeof SubagentParams>;
	const params = withoutLegacyWait(withoutRemovedLaunchFields(args as { tasks?: unknown }));
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((task: unknown) =>
				typeof task === "object" && task !== null && !Array.isArray(task) ? withoutRemovedLaunchFields(task) : task,
			)
		: undefined;
	return (tasks === undefined ? params : { ...params, tasks }) as Static<typeof SubagentParams>;
}

function hasSubagentChildRecords(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE);
}

function hasSubagentSessionHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE) ||
			(entry.type === "custom_message" && SUBAGENT_MESSAGE_TYPES.has(entry.customType)) ||
			(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent"),
	);
}

type ToolRenderCallArgs = Parameters<NonNullable<ToolDefinition["renderCall"]>>;
type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;

function renderSubagentCallFallback(controller: LazyBuiltinController, args: ToolRenderCallArgs) {
	const loaded = controller.active?.captured.tools.get("subagent")?.renderCall;
	if (loaded) return loaded(...args);
	const theme = args[1];
	return new Text(theme.fg("toolTitle", theme.bold("Subagent")), 0, 0);
}

function renderSubagentResultFallback(controller: LazyBuiltinController, args: ToolRenderResultArgs) {
	const loaded = controller.active?.captured.tools.get("subagent")?.renderResult;
	if (loaded) return loaded(...args);
	const [result, , theme] = args;
	const firstText = result.content.find((block) => block.type === "text")?.text ?? "";
	return new Text(theme.fg("toolOutput", firstText), 0, 0);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const subagentsLazyBuiltinSpec: LazyBuiltinSpec = {
	label: "subagents",
	managedEvents: MANAGED_EVENTS,
	interceptedBusEvents: INTERCEPTED_BUS_EVENTS,
	register(pi, controller) {
		// Buffer this session's Intercom id while Subagents is dormant so children launched after
		// activation still know their supervisor's Intercom session id.
		let bufferedIntercomConnected: unknown;
		let sessionHadChildRecords = false;

		controller.onDormantShutdown(() => {
			bufferedIntercomConnected = undefined;
			sessionHadChildRecords = false;
		});

		controller.onActivated(async (handle) => {
			if (bufferedIntercomConnected !== undefined) {
				for (const handler of [...(handle.captured.eventHandlers.get(INTERCOM_CONNECTED_EVENT) ?? [])]) {
					await handler(bufferedIntercomConnected);
				}
			}
		});

		const hasArchivedChildren = (sessionManager: { getArchivedChildCatalog?: () => readonly unknown[] }): boolean =>
			(sessionManager.getArchivedChildCatalog?.().length ?? 0) > 0;

		controller.onSessionStart(async (_event, ctx) => {
			let hasHistory = false;
			try {
				const entries = ctx.sessionManager.getEntries();
				sessionHadChildRecords = hasSubagentChildRecords(entries) || hasArchivedChildren(ctx.sessionManager);
				hasHistory = sessionHadChildRecords || hasSubagentSessionHistory(entries);
			} catch {
				sessionHadChildRecords = false;
				hasHistory = false;
			}
			// Fresh sessions stay dormant; resumed sessions with subagent records, archived children,
			// or cards activate immediately so holds, child cards, slash snapshots, and renderers restore.
			if (hasHistory) {
				await controller.activate(ctx);
			}
		});

		pi.on("session_recovery_restore", async (event, ctx) => {
			if (ctx.subagentPolicy !== undefined) return undefined;
			let hasRecords = sessionHadChildRecords;
			if (!hasRecords) {
				try {
					hasRecords =
						hasSubagentChildRecords(ctx.sessionManager.getEntries()) || hasArchivedChildren(ctx.sessionManager);
				} catch {
					hasRecords = false;
				}
			}
			if (!hasRecords && !controller.active) return undefined;
			await controller.activate(ctx);
			return (await controller.dispatchHandlers("session_recovery_restore", event, ctx)) as
				| { notices?: string[] }
				| undefined;
		});

		pi.events.on(INTERCOM_CONNECTED_EVENT, (payload) => {
			bufferedIntercomConnected = payload;
			if (controller.active) {
				void controller.dispatchBusEvent(INTERCOM_CONNECTED_EVENT, payload);
			}
		});

		// Read-only Intercom queries while dormant: a fresh session that never activated Subagents
		// has no launched children, finished child asks, or pending restorations.
		for (const channel of [
			SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT,
			SUBAGENT_FINISHED_ASKS_EVENT,
			SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT,
		] as const) {
			pi.events.on(channel, (payload) => {
				if (!isObjectRecord(payload) || payload.completion) return;
				if (controller.active) {
					void controller.dispatchBusEvent(channel, payload);
					return;
				}
				payload.completion = Promise.resolve([]);
			});
		}

		pi.events.on(SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT, (payload) => {
			if (!isObjectRecord(payload) || payload.completion) return;
			if (typeof payload.ownerSessionId !== "string" || typeof payload.target !== "string") return;
			if (controller.active) {
				void controller.dispatchBusEvent(SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT, payload);
				return;
			}
			payload.completion = Promise.resolve(undefined);
		});

		// Action / bridge bus events: activate Subagents on demand and forward the payload.
		for (const channel of [
			SUBAGENT_CONTROL_EVENT,
			SUBAGENT_COMPLETE_EVENT,
			SLASH_SUBAGENT_REQUEST_EVENT,
			SLASH_SUBAGENT_CANCEL_EVENT,
			PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
			PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
		] as const) {
			pi.events.on(channel, (payload) => {
				if (controller.active) {
					void controller.dispatchBusEvent(channel, payload);
					return;
				}
				void controller
					.activate(controller.latestContext())
					.then(async (handle) => {
						handle.assertCurrent();
						await controller.dispatchBusEvent(channel, payload);
					})
					.catch(() => {});
			});
		}

		for (const customType of [
			SLASH_RESULT_TYPE,
			SUBAGENT_NOTIFY_TYPE,
			SUBAGENT_LATE_TOOL_RESULT_TYPE,
			SUBAGENT_RESUME_NOTE_TYPE,
			SUBAGENT_CONTROL_MESSAGE_TYPE,
		] as const) {
			pi.registerMessageRenderer(customType, (message, options, theme) => {
				const loaded = controller.active?.captured.messageRenderers.get(customType);
				if (loaded) return loaded(message, options, theme);
				const content = typeof message.content === "string" ? message.content : "";
				return new Text(theme.fg("toolOutput", content), 0, 0);
			});
		}

		pi.registerTool({
			name: "subagent",
			exposure: "model-only",
			scriptAccess: subagentScriptAccess,
			label: "Subagent",
			description: SUBAGENT_TOOL_DESCRIPTION,
			parameters: SubagentParams,
			prepareArguments: prepareSubagentArguments,
			promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
			execute: (...args) => controller.executeTool("subagent", args),
			renderCall: (...args) => renderSubagentCallFallback(controller, args),
			renderResult: (...args) => renderSubagentResultFallback(controller, args),
		});

		pi.registerCommand("agents", {
			description: "Browse available subagents and inspect their configuration",
			handler: (args, ctx) => controller.runCommand("agents", args, ctx),
		});
	},
};
