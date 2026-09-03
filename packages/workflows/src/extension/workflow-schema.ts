import { type Static, Type } from "typebox";

/**
 * Advertise the JSON value types accepted by workflow-answer responses.
 *
 * `Type.Unknown()` emits `{}`, which tells a provider nothing about this
 * property. A retained session shows an assistant tool call that answered a
 * `ctx.ui.confirm` prompt with the string `"true"` rather than a boolean, so
 * naming the accepted types is worth doing. It is not the runtime fix: no
 * inspected host or pi-ai layer converts a boolean to a string, and prompt-kind
 * normalization happens at the pending-prompt boundary, not in provider
 * argument validation.
 *
 * String comes first so validation does not convert text answers to booleans.
 */
const WorkflowResponseSchema = Type.Union(
	[
		Type.String(),
		Type.Boolean(),
		Type.Number(),
		Type.Null(),
		Type.Array(Type.Unknown()),
		Type.Record(Type.String(), Type.Unknown()),
	],
	{
		description:
			"Answer payload for a pending stage prompt. Primitive prompts accept text strings, booleans, or numeric select indexes according to the prompt kind; structured prompts may accept JSON arrays or objects.",
	},
);

/** Run-budget declaration accepted by config, authored workflows, and tool runs. */
export const WorkflowBudgetSchema = Type.Object(
	{
		maxDurationMs: Type.Optional(
			Type.Integer({ minimum: 0, description: "Maximum run duration in milliseconds; 0 disables it." }),
		),
		maxTokens: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum charged tokens; 0 disables it." })),
		maxCost: Type.Optional(Type.Number({ minimum: 0, description: "Maximum cost in USD; 0 disables it." })),
		warnAtPercent: Type.Optional(
			Type.Number({ minimum: 0, description: "Usage percentage at which to warn; 0 disables it." }),
		),
	},
	{ additionalProperties: false, description: "Optional workflow run budget." },
);

export const WorkflowParametersSchema = Type.Object(
	{
		workflow: Type.Optional(
			Type.String({
				description: "Named workflow ID for named-workflow execution.",
			}),
		),
		inputs: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				default: {},
				description: "Key/value inputs passed to a named workflow run.",
			}),
		),
		budget: Type.Optional(WorkflowBudgetSchema),
		action: Type.Optional(
			Type.Union(
				[
					Type.Literal("models"),
					Type.Literal("run"),
					Type.Literal("list"),
					Type.Literal("get"),
					Type.Literal("inputs"),
					Type.Literal("status"),
					Type.Literal("stages"),
					Type.Literal("stage"),
					Type.Literal("transcript"),
					Type.Literal("answer"),
					Type.Literal("pause"),
					Type.Literal("interrupt"),
					Type.Literal("quit"),
					Type.Literal("resume"),
					Type.Literal("reload"),
				],
				{
					description:
						"Workflow action: run/list/get/inputs/models/status, inspect stage metadata, answer pending prompts, pause/resume/interrupt/quit runs, inspect the configured model catalog, or reload workflow resources. 'status' without runId lists every workflow run in the current session with concise per-run summaries (status, timing, active stages, awaiting-input prompts); filter the listing with statusFilter. 'status' with runId returns one run's full detail. For transcript inspection, prefer status/stages/stage first to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.",
				},
			),
		),
		runId: Type.Optional(
			Type.String({
				description:
					"Full 36-character run UUID or unique 8-character hexadecimal UUID prefix for status/stages/stage/transcript/answer/pause/resume/interrupt/quit. Other truncated forms are rejected; ambiguous prefixes require the full UUID. Omit runId with action 'status' to list all session runs and their statuses. Use '--all' or all:true for supported bulk run-control actions.",
			}),
		),
		all: Type.Optional(
			Type.Boolean({
				description:
					"Apply supported run-control actions (pause/interrupt/quit) to all in-flight runs instead of one run; cannot be combined with stageId.",
			}),
		),
		stageId: Type.Optional(
			Type.String({
				description:
					"Exact stage id or exact stage name for stage-scoped inspection, transcript, answer, pause, or resume. Prefixes and partial names are not accepted. A nested stage id is the full 'runId:stageId' composite. For interrupt and quit it may also name an in-flight ctx.tool node by its exact tool:<argsHash> id or tool name, which aborts that single call.",
			}),
		),
		message: Type.Optional(
			Type.String({
				description: "Prompt answer text for answer, or optional text forwarded when resuming paused work.",
			}),
		),
		statusFilter: Type.Optional(
			Type.Union(
				[
					Type.Literal("pending"),
					Type.Literal("running"),
					Type.Literal("awaiting_input"),
					Type.Literal("paused"),
					Type.Literal("blocked"),
					Type.Literal("completed"),
					Type.Literal("failed"),
					Type.Literal("skipped"),
					Type.Literal("cancelled"),
					Type.Literal("killed"),
					Type.Literal("all"),
				],
				{
					description:
						"Filter stages (stages action) or listed runs (status action without runId) by status; 'all' (default) includes everything. For the status listing, run statuses match directly, 'awaiting_input' selects runs with at least one stage awaiting input or pending human prompt, and in-flight runs are listed first.",
				},
			),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("text"), Type.Literal("json")], {
				description:
					"Agent-visible output format for data-bearing inspection actions (models, status, stages, stage, transcript); 'json' returns the full structured result.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Transcript-only: explicitly inline at most this many recent entries. Omit both limit and tail to use the path-only default when sessionFile/transcriptPath exists; prefer rg/grep on the exact quoted sessionFile/transcriptPath for targeted lookup without rewriting platform path separators.",
			}),
		),
		tail: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Transcript-only: explicitly inline the last N entries; overrides limit. Use for quick recent-context checks after status/stages/stage expose the transcript path.",
			}),
		),
		includeToolOutput: Type.Optional(
			Type.Boolean({
				description:
					"Transcript-only: include captured tool output entries when building inlined snapshot previews; this does not bypass the path-only default. Prefer rg/grep on the exact quoted sessionFile/transcriptPath for large outputs. Live session transcripts may not expose tool output.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "Text for a pending prompt answer.",
			}),
		),
		response: Type.Optional(WorkflowResponseSchema),
		promptId: Type.Optional(
			Type.String({
				description: "Pending prompt identifier for the answer action.",
			}),
		),
		reason: Type.Optional(
			Type.String({
				description: "Human-readable reason for the reload action, echoed in the reload result.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type WorkflowParameters = Static<typeof WorkflowParametersSchema>;
