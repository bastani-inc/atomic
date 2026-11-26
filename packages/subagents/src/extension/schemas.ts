/**
 * TypeBox schemas for subagent tool parameters
 */

import { type Static, Type } from "@bastani/atomic-ai";
import { withoutLegacyWait } from "../runs/foreground/legacy-foreground-wait.js";
import { warnRemovedRoutingOption } from "../shared/removed-routing-warning.js";
import {
	MAX_PARALLEL_TASKS,
	REMOVED_SUBAGENT_ACTIONS,
	removedSubagentActionMessage,
	SUBAGENT_ACTIONS,
} from "../shared/types.js";

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

export const SubagentParams = Type.Object(
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
		// Management action (when present, tool operates in management mode)
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
				description: "Deprecated and ignored: a subagent's session is always kept in the launching session's store",
			}),
		),
		control: Type.Optional(ControlOverrides),
		// Solo agent overrides
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

/** Launch fields of removed automatic model routing that calls may still pass; they are dropped and ignored. */
const REMOVED_LAUNCH_FIELDS = ["taskNeeds", "modelConstraints"] as const;

function withoutRemovedLaunchFields<T extends object>(value: T): T {
	if (!REMOVED_LAUNCH_FIELDS.some((field) => Object.hasOwn(value, field))) return value;
	for (const field of REMOVED_LAUNCH_FIELDS) if (Object.hasOwn(value, field)) warnRemovedRoutingOption(field);
	const removed: ReadonlySet<string> = new Set(REMOVED_LAUNCH_FIELDS);
	return Object.fromEntries(Object.entries(value).filter(([key]) => !removed.has(key))) as T;
}

/**
 * Reject removed control actions before schema validation, so the error names their replacement
 * instead of reporting an unknown enum value. Fields of removed automatic model routing are dropped, and so is the
 * removed launch `wait`: every launch runs in the background.
 */
export function prepareSubagentArguments(args: unknown): Static<typeof SubagentParams> {
	const action = typeof args === "object" && args !== null ? (args as { action?: string }).action : undefined;
	if (action !== undefined && (REMOVED_SUBAGENT_ACTIONS as readonly string[]).includes(action))
		throw new Error(removedSubagentActionMessage(action));
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args as Static<typeof SubagentParams>;
	const params = withoutLegacyWait(withoutRemovedLaunchFields(args as { tasks?: unknown }));
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((task: unknown) =>
				typeof task === "object" && task !== null && !Array.isArray(task) ? withoutRemovedLaunchFields(task) : task,
			)
		: undefined;
	return (tasks === undefined ? params : { ...params, tasks }) as Static<typeof SubagentParams>;
}
