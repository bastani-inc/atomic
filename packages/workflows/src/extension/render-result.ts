import { sliceHead } from "@bastani/atomic";
import type { SerializedJournalStoreError } from "@bastani/atomic/storage";
import { wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { ForkErrorCode } from "../durable/fork-errors.js";
import type { SharedPoolStats } from "../durable/journal/sql-shared-pool.js";
import type { WorkflowForkedFrom } from "../durable/types.js";
import type { RunDetail } from "../runs/background/status.js";
import { describeReadinessDecision } from "../runs/foreground/readiness-decision.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type {
	PendingPrompt,
	RunSnapshot,
	RunStatus,
	StageInputRequest,
	StageSnapshot,
	StageStatus,
} from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { boundedToolText, TOOL_PAYLOAD_VALUE_LIMIT } from "../shared/tool-payload-bounds.js";
import type { WorkflowDetails, WorkflowInputValues, WorkflowOutputValues } from "../shared/types.js";
import { inertDisplayLine, inertDisplayText, withoutStackFrames } from "../tui/display-text.js";
import { fmtDuration, statusIcon } from "../tui/status-helpers.js";
import { truncateToWidth, visibleWidth } from "../tui/text-helpers.js";
import { type SharedPoolStatusUnavailable, sharedPoolStatusLines } from "../workers/shared-pool-status-lines.js";
import type { WorkflowControlFailedRun, WorkflowControlFailureCode } from "./workflow-control-failure.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import type { WorkflowRunStatusDigest } from "./workflow-status-digest.js";
import type { WorkflowRunStatusFilter, WorkflowRunStatusSummary } from "./workflow-status-summary.js";
import { getWorkflowStatusRenderRuns } from "./workflow-status-summary.js";

export interface WorkflowInputEntry {
	name: string;
	type: string;
	description?: string;
	required?: boolean;
	default?: unknown;
	choices?: readonly string[];
	placeholder?: string;
	const?: string | number | boolean;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
}

export interface WorkflowListItem {
	name: string;
	description: string;
	inputs: ReadonlyArray<{ name: string; required?: boolean }>;
}
type ListResult = {
	action: "list";
	items: WorkflowListItem[];
};
type StatusResult = {
	action: "status";
	filter: WorkflowRunStatusFilter;
	runs: WorkflowRunStatusSummary[];
	snapshots: RunSnapshot[];
};
type StatusDetailResult =
	| {
			action: "statusDetail";
			runId: string;
			detail: RunDetail;
			sharedPool?: SharedPoolStats;
			sharedPoolUnavailable?: SharedPoolStatusUnavailable;
	  }
	| {
			action: "statusDetail";
			runId: string;
			error: string;
	  };
type StatusSummaryResult = {
	action: "statusSummary";
	runId: string;
	summary: WorkflowRunStatusDigest;
};
type InputsResult = { action: "inputs"; name: string; inputs: WorkflowInputEntry[]; error?: string };
type GetResult = {
	action: "get";
	workflow: string;
	details?: WorkflowDetails;
	error?: string;
};
type RunResult = {
	action: "run";
	name?: string;
	runId: string;
	status: string;
	result?: WorkflowOutputValues;
	details?: WorkflowDetails;
	error?: string;
	exited?: boolean;
	exitReason?: string;
	stages?: StageSnapshot[];
	message?: string;
};
type StageListItem = {
	id: string;
	name: string;
	status: StageStatus;
	wait?: StageSnapshot["wait"];
	sessionId?: string;
	sessionFile?: string;
	transcriptPath?: string;
	error?: string;
	skippedReason?: string;
	awaitingInputSince?: number;
	pendingPrompt?: PendingPrompt;
	inputRequest?: StageInputRequest;
	promptFootprint?: PendingPrompt;
	startup?: StageSnapshot["startup"];
	workerExecution?: StageSnapshot["workerExecution"];
	readinessDecision?: StageSnapshot["readinessDecision"];
};
type StageListResult = { action: "stages"; runId: string; filter: string; stages: StageListItem[]; error?: string };
type StageDetailItem = StageSnapshot & { transcriptPath?: string };
type StageDetailResult = { action: "stage"; runId: string; stage?: StageDetailItem; error?: string };
type TranscriptEntry = { role: string; text?: string; toolName?: string; output?: string; timestamp?: number };
type TranscriptInlineMode = "path_only" | "preview" | "fallback_preview";
type TranscriptResult = {
	action: "transcript";
	runId: string;
	stageId: string;
	source: "live" | "snapshot" | "error";
	entries: TranscriptEntry[];
	truncated: boolean;
	entryCount?: number;
	entryLimit?: number;
	sessionId?: string;
	sessionFile?: string;
	transcriptPath?: string;
	lazyReadPrompt?: string;
	fallbackNote?: string;
	inlineMode?: TranscriptInlineMode;
};
type AnswerResult = {
	action: "answer";
	runId: string;
	stageId: string;
	message: string;
} & (
	| { status: "ok" | "noop" }
	| { status: "failed"; code: "WORKFLOW_TERMINAL"; workflowStatus: RunStatus; error: string }
);
type PauseResult = {
	action: "pause";
	runId: string;
	status: string;
	message: string;
	code?: WorkflowControlFailureCode;
	failedRuns?: readonly WorkflowControlFailedRun[];
};
type ReloadResult = WorkflowReloadReport & { action: "reload"; status: "ok" | "noop"; message: string };
type QuitResult = {
	action: "quit";
	runId: string;
	status: string;
	message: string;
	code?: WorkflowControlFailureCode;
	failedRuns?: readonly WorkflowControlFailedRun[];
};
type ResumeResult = {
	action: "resume";
	runId: string;
	status: string;
	message: string;
	code?: WorkflowControlFailureCode;
	failure?: SerializedJournalStoreError;
};
export type ForkResult = {
	action: "fork";
	runId: string;
	sourceRunId: string;
	status: "running" | "forked" | "failed";
	message: string;
	forkedFrom?: WorkflowForkedFrom;
	startFailure?: WorkflowControlFailureCode;
	code?: ForkErrorCode;
	hint?: string;
};

export type ToolNodeControlResult<TAction extends "quit" | "pause" = "quit" | "pause"> = {
	readonly action: TAction;
	readonly runId: string;
	readonly stageId: string;
	readonly status: "cancelled";
	readonly workflowStatus: RunStatus;
	readonly abandoned: boolean;
	readonly message: string;
};
export interface ModelCatalogEntry {
	provider: string;
	id: string;
	fullId: string;
	isCurrent: boolean;
	availableThinkingLevels?: readonly string[];
}
type ModelsResult = { action: "models"; models: ModelCatalogEntry[] };

export type WorkflowTimeoutResult = {
	action: NonNullable<import("./public-types.js").WorkflowToolArgs["action"]>;
	status: "failed";
	code: "WORKFLOW_TIMEOUT";
	timeoutMs: number;
	runId?: string;
	error: string;
};

export type WorkflowToolResult =
	| ListResult
	| StatusResult
	| StatusDetailResult
	| StatusSummaryResult
	| InputsResult
	| GetResult
	| RunResult
	| StageListResult
	| StageDetailResult
	| TranscriptResult
	| AnswerResult
	| PauseResult
	| ReloadResult
	| QuitResult
	| ResumeResult
	| ForkResult
	| ToolNodeControlResult
	| ModelsResult;

export type WorkflowRegisteredToolResult = WorkflowToolResult | WorkflowTimeoutResult;

export interface RenderResultOpts {
	isPartial?: boolean;
	errorText?: string;
	width?: number;
	runInputs?: Readonly<WorkflowInputValues>;
	plain?: boolean;
	now?: number;
	allRuns?: readonly RunSnapshot[];
}

function fitLine(line: string, width?: number): string {
	if (width === undefined || width <= 0) return line;
	return truncateToWidth(line, width, "…");
}

function fitLines(lines: readonly string[], width?: number): string {
	if (width === undefined || width <= 0) return lines.join("\n");
	const budget = Math.max(1, Math.floor(width));
	return lines
		.flatMap((line) => {
			if (line.length === 0) return [""];
			return wrapTextWithAnsi(line, budget).map((part) =>
				visibleWidth(part) <= budget ? part : truncateToWidth(part, budget, "…"),
			);
		})
		.join("\n");
}

function renderNotice(title: string, message: string, opts: RenderResultOpts | undefined): string {
	const clean = inertDisplayText(boundedToolText(message, TOOL_PAYLOAD_VALUE_LIMIT));
	const rawLines = clean.split(/\r?\n/);
	if (rawLines.length <= 1) {
		return fitLines([`${title}: ${rawLines[0] ?? ""}`], opts?.width);
	}
	return fitLines([title, ...rawLines], opts?.width);
}

function errorNoticeText(errorText: string): string {
	const bounded = boundedToolText(inertDisplayText(errorText), TOOL_PAYLOAD_VALUE_LIMIT);
	const { kept, frames } = withoutStackFrames(bounded);
	const body = kept.join("\n").trimEnd();
	return frames > 0 ? `${body}\n(${frames} stack ${frames === 1 ? "frame" : "frames"} hidden)` : body;
}

function statusDigestNoticeText(digest: WorkflowRunStatusDigest): string {
	const lines = [`${digest.name} ${digest.runId}: ${digest.status}`];
	if (digest.error !== undefined) lines.push(`error: ${digest.error}`);
	if (digest.result !== undefined) lines.push(`result: ${JSON.stringify(digest.result)}`);
	for (const blocker of digest.blockers) {
		lines.push(`${blocker.kind}: ${blocker.name}${blocker.message === undefined ? "" : ` — ${blocker.message}`}`);
	}
	for (const notice of digest.worktreeRestore ?? []) lines.push(`checkout: ${notice}`);
	return lines.join("\n");
}

const TRANSCRIPT_NOTICE_ENTRY_LIMIT = 5;
const TRANSCRIPT_NOTICE_CHAR_LIMIT = 240;

function transcriptEntriesNoticeText(entries: readonly TranscriptEntry[]): string {
	if (entries.length === 0) return "no transcript entries";
	const shown = entries.slice(0, TRANSCRIPT_NOTICE_ENTRY_LIMIT);
	const text = shown
		.map((entry) => `${entry.role}: ${entry.text ?? entry.output ?? entry.toolName ?? "(no body)"}`)
		.join(" | ");
	const entrySuffix = entries.length > shown.length ? ` … (+${entries.length - shown.length} more)` : "";
	return fitLine(`${text}${entrySuffix}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
}

function transcriptNoticeText(result: TranscriptResult): string {
	if ((result.inlineMode === "path_only" || result.lazyReadPrompt !== undefined) && result.entries.length === 0) {
		const path = result.transcriptPath ?? result.sessionFile ?? "transcript file";
		const count =
			result.entryCount === undefined
				? ""
				: ` (${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"})`;
		return fitLine(`not inlined; read ${path}${count}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
	}
	const entriesText = transcriptEntriesNoticeText(result.entries);
	if (result.inlineMode === "fallback_preview" || result.fallbackNote !== undefined) {
		return fitLine(`no session file; preview: ${entriesText}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
	}
	return entriesText;
}

function renderListLines(items: readonly WorkflowListItem[], width?: number): string {
	const lines: string[] = [`WORKFLOWS · ${items.length} registered`];
	if (items.length === 0) {
		lines.push("no workflows registered");
		return fitLines(lines, width);
	}
	for (const item of items) {
		const inputs =
			item.inputs.length === 0
				? "inputs: (none)"
				: `inputs: ${item.inputs.map((inp) => (inp.required ? inp.name : `${inp.name}?`)).join(", ")}`;
		lines.push(`${inertDisplayLine(item.name)} — ${inertDisplayLine(item.description)}`);
		lines.push(`  ${inertDisplayLine(inputs)}`);
	}
	return fitLines(lines, width);
}

function renderStatusLines(snapshots: readonly RunSnapshot[], opts?: RenderResultOpts): string {
	const now = opts?.now ?? Date.now();
	const lines: string[] = [`BACKGROUND · ${snapshots.length} ${snapshots.length === 1 ? "run" : "runs"}`];
	if (snapshots.length === 0) {
		lines.push("no workflow runs in current session");
		return fitLines(lines, opts?.width);
	}
	for (const run of snapshots) {
		const status = effectiveRunStatus(run);
		const icon = statusIcon(status);
		const dur = fmtDuration(elapsedRunMs(run, now));
		lines.push(`${icon} ${inertDisplayLine(run.id)}  ${inertDisplayLine(run.name)}  ${status}  ${dur}`);
	}
	return fitLines(lines, opts?.width);
}

function renderStatusDetailLines(
	r: Extract<StatusDetailResult, { detail: RunDetail }>,
	opts?: RenderResultOpts,
): string {
	const now = opts?.now ?? Date.now();
	const { detail } = r;
	const lines: string[] = [
		`RUN ${inertDisplayLine(detail.name)} · ${detail.status}`,
		`run id ${inertDisplayLine(detail.runId)}`,
		`duration ${fmtDuration(elapsedRunMs(detail, now))}`,
	];
	if (detail.error) {
		const first = withoutStackFrames(sliceHead(detail.error, 4096)).kept[0] ?? detail.error;
		lines.push(`error ${inertDisplayLine(first)}`);
	}
	for (const stage of detail.stages) {
		lines.push(`  ${statusIcon(stage.status)} ${inertDisplayLine(stage.name)} (${stage.id}) ${stage.status}`);
	}
	for (const tool of detail.tools) {
		lines.push(`  ${inertDisplayLine(tool.name)} (${tool.id}) ${tool.status}`);
	}
	const pool =
		r.sharedPool !== undefined
			? { sharedPool: r.sharedPool }
			: r.sharedPoolUnavailable !== undefined
				? { sharedPoolUnavailable: r.sharedPoolUnavailable }
				: undefined;
	if (pool !== undefined) {
		lines.push(...sharedPoolStatusLines(pool).map((line) => inertDisplayLine(line)));
	}
	return fitLines(lines, opts?.width);
}

function renderInputsLines(name: string, inputs: readonly WorkflowInputEntry[], width?: number): string {
	const safeName = inertDisplayLine(name);
	if (inputs.length === 0) {
		return fitLines([`INPUTS FOR ${safeName}`, `Workflow has no declared inputs. Workflow: "${safeName}".`], width);
	}
	const lines: string[] = [`INPUTS FOR ${safeName}`];
	for (const field of inputs) {
		const tag = field.required ? "required" : "optional";
		lines.push(`${inertDisplayLine(field.name)}  ${inertDisplayLine(field.type)} · ${tag}`);
		if (field.description) lines.push(`  ${inertDisplayLine(field.description)}`);
		if (field.choices && field.choices.length > 0) {
			lines.push(`  values: ${field.choices.map((c) => inertDisplayLine(c)).join(" · ")}`);
		}
		if (field.default !== undefined) {
			lines.push(`  default: ${inertDisplayLine(JSON.stringify(field.default))}`);
		}
	}
	return fitLines(lines, width);
}

function renderRunLines(r: RunResult, opts?: RenderResultOpts): string {
	const partial = opts?.isPartial === true;
	if (partial) return renderNotice("WORKFLOW RUN", `${r.runId}: ${r.status} (in progress…)`, opts);
	if (r.status === "failed" && !r.runId) {
		const label = r.name ? ` (${r.name})` : "";
		return renderNotice("WORKFLOW RUN", `${label || "workflow"}: ${r.error ?? "workflow not found"}`, opts);
	}
	if (r.error) {
		const label = r.name ? ` (${r.name})` : "";
		return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.status} — ${r.error}`, opts);
	}
	if (r.details && r.details.status !== "accepted") {
		const label = r.name ? ` (${r.name})` : "";
		const guidance = r.details.message === undefined ? "" : ` — ${r.details.message}`;
		return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.details.mode} ${r.details.status}${guidance}`, opts);
	}
	if (
		r.status === "completed" ||
		r.status === "failed" ||
		r.status === "skipped" ||
		r.status === "cancelled" ||
		r.status === "blocked" ||
		r.status === "killed"
	) {
		const label = r.name ? ` (${r.name})` : "";
		return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.status}`, opts);
	}
	if (r.name && r.runId) {
		const inputs = opts?.runInputs ?? {};
		const inputSummary = Object.entries(inputs)
			.map(([k, v]) => `${inertDisplayLine(k)}=${inertDisplayLine(typeof v === "string" ? v : JSON.stringify(v))}`)
			.join(" · ");
		const lines = [
			`${inertDisplayLine(r.name)} · ${statusIcon("running")} running${inputSummary ? ` · ${inputSummary}` : ""}`,
			`run ${inertDisplayLine(r.runId)} · /workflows ${inertDisplayLine(r.runId)}`,
		];
		return fitLines(lines, opts?.width);
	}
	const label = r.name ? ` (${r.name})` : "";
	return renderNotice("WORKFLOW RUN", `${r.runId}${label}: started in background — ${r.message ?? r.status}`, opts);
}

export function renderResult(result: WorkflowRegisteredToolResult | null | undefined, opts?: RenderResultOpts): string {
	return renderResultBody(result, opts);
}

function renderResultBody(result: WorkflowRegisteredToolResult | null | undefined, opts?: RenderResultOpts): string {
	const partial = opts?.isPartial === true;

	if (result === null || result === undefined || typeof result.action !== "string") {
		if (opts?.errorText !== undefined) return renderNotice("WORKFLOW ERROR", errorNoticeText(opts.errorText), opts);
		return partial ? "" : renderNotice("WORKFLOW", "no result", opts);
	}
	if ("code" in result && result.code === "WORKFLOW_TIMEOUT") {
		return renderNotice("WORKFLOW TIMEOUT", result.error, opts);
	}

	switch (result.action) {
		case "list": {
			const r = result as ListResult;
			return renderListLines(r.items, opts?.width);
		}

		case "status": {
			const r = result as StatusResult;
			const allRuns = opts?.allRuns ?? getWorkflowStatusRenderRuns(r) ?? r.snapshots;
			return renderStatusLines(r.snapshots, { ...opts, allRuns });
		}

		case "statusSummary": {
			const { summary } = result as StatusSummaryResult;
			return renderNotice("WORKFLOW STATUS", statusDigestNoticeText(summary), opts);
		}

		case "statusDetail": {
			if ("error" in result) {
				const r = result as Extract<StatusDetailResult, { error: string }>;
				return renderNotice("WORKFLOW STATUS", `id=${r.runId}: ${r.error}`, opts);
			}
			const r = result as Extract<StatusDetailResult, { detail: RunDetail }>;
			return renderStatusDetailLines(r, opts);
		}

		case "inputs": {
			const r = result as InputsResult;
			if (r.error) return renderNotice("WORKFLOW INPUTS", `${r.name}: ${r.error}`, opts);
			return renderInputsLines(r.name, r.inputs, opts?.width);
		}

		case "get": {
			const r = result as GetResult;
			if (r.error) return renderNotice("WORKFLOW GET", `${r.workflow}: ${r.error}`, opts);
			const output = r.details?.output;
			const description = typeof output?.description === "string" ? ` — ${output.description}` : "";
			return renderNotice("WORKFLOW GET", `${r.workflow}: ${r.details?.status ?? "completed"}${description}`, opts);
		}

		case "run": {
			const r = result as RunResult;
			return renderRunLines(r, opts);
		}

		case "stages": {
			const r = result as StageListResult;
			if (r.error) return renderNotice("WORKFLOW STAGES", `${r.runId || "(none)"}: ${r.error}`, opts);
			const counts = r.stages
				.map(
					(s) =>
						`${s.name} (${s.id}): ${s.status}${s.skippedReason ? ` — ${s.skippedReason}` : ""}${s.readinessDecision ? ` — ${describeReadinessDecision(s.readinessDecision)}` : ""}`,
				)
				.join("; ");
			return renderNotice("WORKFLOW STAGES", `${r.runId}: ${r.filter} — ${counts || "no stages"}`, opts);
		}

		case "stage": {
			const r = result as StageDetailResult;
			if (r.error || !r.stage)
				return renderNotice("WORKFLOW STAGE", `${r.runId}: ${r.error ?? "stage not found"}`, opts);
			const extra = r.stage.error ? ` — ${r.stage.error}` : r.stage.result ? ` — ${r.stage.result}` : "";
			return renderNotice(
				"WORKFLOW STAGE",
				`${r.runId}: ${r.stage.name} (${r.stage.id}) ${r.stage.status}${extra}`,
				opts,
			);
		}

		case "transcript": {
			const r = result as TranscriptResult;
			const text = transcriptNoticeText(r);
			const suffix = r.truncated ? " (truncated)" : "";
			return renderNotice("WORKFLOW TRANSCRIPT", `${r.runId}/${r.stageId} ${r.source}: ${text}${suffix}`, opts);
		}

		case "answer": {
			const r = result as AnswerResult;
			return renderNotice("WORKFLOW ANSWER", `${r.runId}/${r.stageId}: ${r.message}`, opts);
		}

		case "pause": {
			const r = result as PauseResult;
			return renderNotice("WORKFLOW PAUSE", `${r.runId}: ${r.message}`, opts);
		}

		case "reload": {
			const r = result as ReloadResult;
			return renderNotice("WORKFLOW RELOAD", r.message, opts);
		}

		case "quit": {
			const r = result as QuitResult;
			return renderNotice("WORKFLOW QUIT", `${r.runId}: ${r.message}`, opts);
		}

		case "resume": {
			const r = result as ResumeResult;
			return renderNotice("WORKFLOW RESUME", `${r.runId}: ${r.message}`, opts);
		}

		case "fork": {
			const r = result as ForkResult;
			return renderNotice("WORKFLOW FORK", `${r.runId.length > 0 ? r.runId : r.sourceRunId}: ${r.message}`, opts);
		}

		case "models": {
			const r = result as ModelsResult;
			if (r.models.length === 0) {
				return renderNotice(
					"WORKFLOW MODELS",
					"no models in configured catalog — configured-auth snapshot, not proof of credentials, entitlements, OAuth freshness, or live provider access.",
					opts,
				);
			}
			const currentLine = r.models.find((model) => model.isCurrent);
			const lines = r.models
				.map((model) => {
					const levels = model.availableThinkingLevels?.length
						? ` [levels: ${model.availableThinkingLevels.join(", ")}]`
						: "";
					return `${model.provider}/${model.id}${model.isCurrent ? " (current)" : ""}${levels}`;
				})
				.join("; ");
			const suffix = currentLine !== undefined ? "" : " (no current model)";
			return renderNotice(
				"WORKFLOW MODELS",
				`${lines}${suffix} — configured-auth catalog snapshot, not proof of credentials, entitlements, OAuth freshness, or live provider access.`,
				opts,
			);
		}

		default: {
			const fallback = result as { action: string; message?: string };
			return renderNotice("WORKFLOW", fallback.message ?? JSON.stringify(result), opts);
		}
	}
}
