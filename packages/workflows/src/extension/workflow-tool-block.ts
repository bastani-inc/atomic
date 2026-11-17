/**
 * The workflow tool's result in the chat, in the tool band every tool uses: one `⎿` line that says how the call
 * ended, or how its run stands while it runs, and the call's details under it when tool output is expanded.
 */

import type { ThemeColor } from "@bastani/atomic";
import { keyHintIfBound } from "@bastani/atomic";
import { wrapTextWithAnsi } from "@bastani/atomic-tui";
import { meter_run, type RunUsageTree } from "../shared/budget-meter.js";
import type { StoreInvalidationListener } from "../shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { WorkflowOutputValues } from "../shared/types.js";
import { truncateToWidth } from "../tui/text-helpers.js";
import type { PiRenderComponent } from "./public-types.js";
import { displayLine, runAskLine, type WorkflowCallLabel, type WorkflowToolArgs } from "./render-call.js";
import type { WorkflowRegisteredToolResult } from "./render-result.js";
import { renderResult } from "./render-result.js";

/** The theme calls the block uses; the host passes its theme, and anything else renders plain. */
export interface WorkflowBlockTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

const PLAIN_THEME: WorkflowBlockTheme = { fg: (_color, text) => text, bold: (text) => text };

export function workflowBlockTheme(theme: unknown): WorkflowBlockTheme {
	const candidate = theme as Partial<WorkflowBlockTheme> | undefined;
	return typeof candidate?.fg === "function" && typeof candidate.bold === "function"
		? (candidate as WorkflowBlockTheme)
		: PLAIN_THEME;
}

/** The runs a block reads its run from, and is told of their changes by. */
export interface WorkflowRunSource {
	run(runId: string): RunSnapshot | undefined;
	childRuns(parentRunId: string): readonly RunSnapshot[];
	subscribeInvalidation(listener: StoreInvalidationListener): () => void;
}

export type WorkflowResultTone = "running" | "success" | "failure" | "warning" | "paused" | "stopped" | "info";

/** How a call ended, or how its run stands, as its `⎿` line says it. */
export interface WorkflowResultSummary {
	readonly tone: WorkflowResultTone;
	readonly text: string;
}

const TONE_MARKERS: Readonly<Record<WorkflowResultTone, { readonly glyph: string; readonly color: ThemeColor }>> = {
	running: { glyph: "∀", color: "accent" },
	success: { glyph: "✓", color: "success" },
	failure: { glyph: "✗", color: "error" },
	warning: { glyph: "!", color: "warning" },
	paused: { glyph: "⏸", color: "muted" },
	stopped: { glyph: "◼", color: "muted" },
	info: { glyph: "", color: "dim" },
};

const STAGE_TONES: Readonly<Record<StageStatus, WorkflowResultTone>> = {
	pending: "info",
	running: "running",
	awaiting_input: "warning",
	paused: "paused",
	blocked: "warning",
	suspended: "paused",
	completed: "success",
	failed: "failure",
	skipped: "stopped",
};

const TERMINAL_RUN_STATUSES = new Set<RunSnapshot["status"]>([
	"completed",
	"failed",
	"blocked",
	"skipped",
	"cancelled",
	"killed",
]);

const SETTLED_STAGE_STATUSES = new Set<StageStatus>(["completed", "failed", "skipped"]);
const FIRST_PREFIX = "  ⎿  ";
const DETAIL_PREFIX = "     ";
const LIST_PREVIEW = 3;

export function formatBlockDuration(ms: number): string {
	const totalSec = Math.floor(Math.max(0, ms) / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function formatBlockTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : nouns}`;
}

/** An error's first message line: never a stack frame, never a line break. */
export function shortReason(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = displayLine(raw);
		if (line.length === 0 || /^at\s/.test(line)) continue;
		return line.replace(/^Error:\s*/, "");
	}
	return undefined;
}

function join(...parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}

function usageTree(source: WorkflowRunSource | undefined, run: RunSnapshot, depth = 0): RunUsageTree {
	const children = source === undefined || depth >= 8 ? [] : source.childRuns(run.id);
	return { run, children: children.map((child) => usageTree(source, child, depth + 1)) };
}

function runTokens(source: WorkflowRunSource | undefined, run: RunSnapshot, now: number): number {
	return meter_run(usageTree(source, run), now).tokens;
}

function stageWhere(run: RunSnapshot, wanted: (stage: StageSnapshot) => boolean): StageSnapshot | undefined {
	return run.stages.find(wanted);
}

function failedStageName(run: RunSnapshot): string | undefined {
	const stage =
		(run.failedStageId === undefined ? undefined : stageWhere(run, (s) => s.id === run.failedStageId)) ??
		stageWhere(run, (s) => s.status === "failed");
	return stage === undefined ? undefined : displayLine(stage.name);
}

function stageProgress(run: { readonly stages: readonly StageSnapshot[] }): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const settled = run.stages.filter((stage) => SETTLED_STAGE_STATUSES.has(stage.status)).length;
	return `${settled}/${total} stages`;
}

/** The `⎿` line for a run, from its live snapshot. */
export function summarizeRun(run: RunSnapshot, tokens: number, now: number): WorkflowResultSummary {
	const progress = stageProgress(run);
	const tokenText = tokens > 0 ? `${formatBlockTokens(tokens)} tokens` : undefined;
	switch (run.status) {
		case "pending":
		case "running": {
			const waiting = stageWhere(run, (stage) => stage.status === "awaiting_input");
			if (waiting !== undefined) {
				return { tone: "warning", text: join(`Waiting for input at ${displayLine(waiting.name)}`, progress) };
			}
			return {
				tone: "running",
				text: join("Running", progress, tokenText === undefined ? undefined : `↓ ${tokenText}`),
			};
		}
		case "paused": {
			const at = stageWhere(run, (stage) => stage.status === "paused" || stage.status === "running");
			const where = at === undefined ? "" : ` at ${displayLine(at.name)}`;
			if (run.exitReason === "quit") return { tone: "stopped", text: join(`Stopped${where}`, progress) };
			return { tone: "paused", text: join(`Paused${where}`, progress) };
		}
		case "completed":
			return {
				tone: "success",
				text: join(
					`Completed in ${formatBlockDuration(elapsedRunMs(run, now))}`,
					run.stages.length > 0 ? plural(run.stages.length, "stage") : undefined,
					tokenText,
				),
			};
		case "failed": {
			const stage = failedStageName(run);
			return {
				tone: "failure",
				text: join(stage === undefined ? "Failed" : `Failed at ${stage}`, shortReason(run.error ?? run.exitReason)),
			};
		}
		case "blocked": {
			const stage = stageWhere(run, (s) => s.status === "blocked" || s.status === "failed");
			return {
				tone: "warning",
				text: join(
					stage === undefined ? "Blocked" : `Blocked at ${displayLine(stage.name)}`,
					shortReason(run.error ?? run.exitReason),
				),
			};
		}
		case "skipped":
			return { tone: "stopped", text: join("Skipped", shortReason(run.exitReason)) };
		default:
			return { tone: "stopped", text: join("Stopped", progress) };
	}
}

/** What a run result says when its run is not in the store: what the call itself reported. */
function summarizeRunResult(result: Extract<WorkflowRegisteredToolResult, { action: "run" }>): WorkflowResultSummary {
	if ("code" in result) return { tone: "failure", text: shortReason(result.error) ?? "Timed out" };
	const status = result.details?.status === "accepted" ? "running" : result.status;
	if (result.error !== undefined && result.error.length > 0) {
		return { tone: "failure", text: join(result.runId ? "Failed" : "Not started", shortReason(result.error)) };
	}
	switch (status) {
		case "running":
		case "pending":
		case "accepted":
			return { tone: "running", text: join("Started in the background", result.runId ? `run ${result.runId}` : "") };
		case "completed":
			return {
				tone: "success",
				text: join("Completed", result.stages?.length ? plural(result.stages.length, "stage") : undefined),
			};
		case "failed":
			return { tone: "failure", text: "Failed" };
		case "blocked":
			return { tone: "warning", text: join("Blocked", shortReason(result.exitReason)) };
		case "paused":
			return { tone: "paused", text: "Paused" };
		default:
			return { tone: "stopped", text: displayLine(status) || "Stopped" };
	}
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`).join(" · ");
}

function namesPreview(names: readonly string[]): string {
	const shown = names.slice(0, LIST_PREVIEW).map(displayLine).join(", ");
	return names.length > LIST_PREVIEW ? `${shown}, +${names.length - LIST_PREVIEW} more` : shown;
}

function controlSummary(result: { status: string; message: string; code?: string }): WorkflowResultSummary {
	const text = shortReason(result.message) ?? result.status;
	if (result.code !== undefined || result.status === "failed") return { tone: "failure", text };
	if (result.status === "noop") return { tone: "info", text };
	return { tone: "success", text };
}

/** The `⎿` line for any workflow tool result, given the run's live snapshot when it has one. */
export function summarizeWorkflowResult(
	result: WorkflowRegisteredToolResult | null | undefined,
	view: { readonly errorText?: string; readonly run?: RunSnapshot; readonly tokens?: number; readonly now: number },
): WorkflowResultSummary {
	if (result === null || result === undefined || typeof result.action !== "string") {
		const reason = shortReason(view.errorText);
		return reason === undefined ? { tone: "info", text: "No result" } : { tone: "failure", text: reason };
	}
	if ("code" in result && result.code === "WORKFLOW_TIMEOUT") {
		return { tone: "failure", text: shortReason(result.error) ?? "Timed out" };
	}
	switch (result.action) {
		case "run":
			return view.run !== undefined
				? summarizeRun(view.run, view.tokens ?? 0, view.now)
				: summarizeRunResult(result as Extract<WorkflowRegisteredToolResult, { action: "run" }>);
		case "list":
			return result.items.length === 0
				? { tone: "info", text: "No workflows" }
				: {
						tone: "info",
						text: `${plural(result.items.length, "workflow")}: ${namesPreview(result.items.map((item) => item.name))}`,
					};
		case "status":
			return result.runs.length === 0
				? { tone: "info", text: result.filter === "all" ? "No runs" : `No ${result.filter} runs` }
				: {
						tone: "info",
						text: join(
							plural(result.runs.length, "run"),
							countBy(result.runs, (run) => run.status),
						),
					};
		case "statusSummary":
			return {
				tone: "info",
				text: join(
					`${displayLine(result.summary.name)} ${result.summary.status}`,
					result.summary.blockers.length > 0 ? plural(result.summary.blockers.length, "blocker") : undefined,
					shortReason(result.summary.error),
				),
			};
		case "statusDetail":
			if ("error" in result) return { tone: "failure", text: shortReason(result.error) ?? "Not found" };
			return {
				tone: "info",
				text: join(
					`${displayLine(result.detail.name)} ${result.detail.status}`,
					stageProgress(result.detail),
					shortReason(result.detail.error),
				),
			};
		case "inputs":
			if (result.error !== undefined) return { tone: "failure", text: shortReason(result.error) ?? "No inputs" };
			return result.inputs.length === 0
				? { tone: "info", text: `${displayLine(result.name)} takes no inputs` }
				: {
						tone: "info",
						text: `${plural(result.inputs.length, "input")}: ${namesPreview(result.inputs.map((input) => input.name))}`,
					};
		case "get": {
			if (result.error !== undefined) return { tone: "failure", text: shortReason(result.error) ?? "Not found" };
			const description = result.details?.output?.description;
			return {
				tone: "info",
				text: join(
					displayLine(result.workflow),
					typeof description === "string" ? shortReason(description) : undefined,
				),
			};
		}
		case "stages":
			if (result.error !== undefined) return { tone: "failure", text: shortReason(result.error) ?? "No stages" };
			return result.stages.length === 0
				? { tone: "info", text: "No stages" }
				: {
						tone: "info",
						text: join(
							plural(result.stages.length, "stage"),
							countBy(result.stages, (stage) => stage.status),
						),
					};
		case "stage":
			if (result.error !== undefined || result.stage === undefined) {
				return { tone: "failure", text: shortReason(result.error) ?? "Stage not found" };
			}
			return {
				tone: STAGE_TONES[result.stage.status] === "running" ? "running" : "info",
				text: join(
					`${displayLine(result.stage.name)} ${result.stage.status.replaceAll("_", " ")}`,
					shortReason(result.stage.error),
				),
			};
		case "transcript":
			if (result.source === "error") return { tone: "failure", text: "Transcript unavailable" };
			return {
				tone: "info",
				text: join(
					plural(result.entryCount ?? result.entries.length, "entry", "entries"),
					result.truncated ? "truncated" : undefined,
				),
			};
		case "answer":
			if (result.status === "failed") return { tone: "failure", text: shortReason(result.error) ?? "Not answered" };
			return {
				tone: result.status === "noop" ? "info" : "success",
				text: shortReason(result.message) ?? "Answered",
			};
		case "pause":
		case "quit":
			if ("stageId" in result && "workflowStatus" in result) {
				return { tone: "stopped", text: shortReason(result.message) ?? "Cancelled" };
			}
			return controlSummary(result);
		case "resume":
		case "fork":
			return controlSummary(result);
		case "reload":
			return {
				tone: result.status === "noop" ? "info" : "success",
				text: shortReason(result.message) ?? "Reloaded",
			};
		case "models": {
			const current = result.models.find((model) => model.isCurrent);
			return result.models.length === 0
				? { tone: "info", text: "No configured models" }
				: {
						tone: "info",
						text: join(plural(result.models.length, "model"), current ? `current ${current.fullId}` : undefined),
					};
		}
		default:
			return { tone: "info", text: "Done" };
	}
}

function valueLine(value: unknown): string {
	if (typeof value === "string") return displayLine(value.split(/\r?\n/).find((line) => line.trim()) ?? "");
	try {
		return displayLine(JSON.stringify(value) ?? String(value));
	} catch {
		return displayLine(String(value));
	}
}

function fieldLines(values: Readonly<Record<string, unknown>> | WorkflowOutputValues | undefined): string[] {
	if (values === undefined || values === null || typeof values !== "object") return [];
	return Object.entries(values).map(([key, value]) => `  ${displayLine(key)}: ${valueLine(value)}`);
}

function stageLine(stage: StageSnapshot, theme: WorkflowBlockTheme, now: number): string {
	const marker = TONE_MARKERS[STAGE_TONES[stage.status]];
	const glyph = marker.glyph === "" ? "·" : marker.glyph;
	const ended = stage.endedAt ?? (stage.status === "running" ? now : undefined);
	const duration =
		stage.durationMs !== undefined
			? formatBlockDuration(stage.durationMs)
			: stage.startedAt !== undefined && ended !== undefined
				? formatBlockDuration(ended - stage.startedAt)
				: undefined;
	const reason = stage.status === "failed" || stage.status === "blocked" ? shortReason(stage.error) : undefined;
	return `  ${theme.fg(marker.color, glyph)} ${join(displayLine(stage.name), stage.status === "completed" ? undefined : stage.status.replaceAll("_", " "), duration, reason)}`;
}

/** The details ctrl+o shows for a run: what it was asked, its stages, and what it returned. */
function runDetailLines(
	run: RunSnapshot | undefined,
	result: Extract<WorkflowRegisteredToolResult, { action: "run" }>,
	args: WorkflowToolArgs | undefined,
	theme: WorkflowBlockTheme,
	now: number,
): string[] {
	const lines: string[] = [];
	const inputs = run?.inputs ?? args?.inputs;
	const inputLines = fieldLines(inputs as Readonly<Record<string, unknown>> | undefined);
	if (inputLines.length > 0) lines.push(theme.bold("Inputs"), ...inputLines);
	const stages = run?.stages ?? ("stages" in result ? result.stages : undefined) ?? [];
	if (stages.length > 0) lines.push(theme.bold("Stages"), ...stages.map((stage) => stageLine(stage, theme, now)));
	const outputs = run?.result ?? ("result" in result ? result.result : undefined);
	const outputLines = fieldLines(outputs);
	if (outputLines.length > 0) lines.push(theme.bold("Outputs"), ...outputLines);
	const error = run?.error ?? ("error" in result ? result.error : undefined);
	if (error !== undefined && error.length > 0) lines.push(theme.bold("Error"), `  ${shortReason(error) ?? ""}`);
	const runId = run?.id ?? ("runId" in result ? result.runId : undefined);
	if (runId) lines.push(theme.fg("dim", `run ${runId} · /workflow status ${runId}`));
	return lines;
}

export interface WorkflowBlockView {
	readonly expanded: boolean;
	readonly partial?: boolean;
	readonly isError: boolean;
	readonly errorText?: string;
	readonly args?: WorkflowToolArgs;
	readonly invalidate?: () => void;
}

export interface WorkflowBlockOptions {
	/** Whether the host lists runs in an agent panel that ↓ focuses, so the running line can say so. */
	readonly agentPanel?: boolean;
	readonly now?: () => number;
}

/**
 * The result part of a workflow tool row. It follows a run it started through the store, repainting only when its
 * line changes, and stops following once the run has ended.
 */
export class WorkflowToolResultBlock implements PiRenderComponent {
	private result: WorkflowRegisteredToolResult | null | undefined;
	private view: WorkflowBlockView = { expanded: false, isError: false };
	private followedRunId: string | undefined;
	private unsubscribe: (() => void) | undefined;
	private lastRun: RunSnapshot | undefined;
	private shown: string | undefined;

	constructor(
		private readonly source: WorkflowRunSource | undefined,
		private readonly theme: WorkflowBlockTheme,
		private readonly options: WorkflowBlockOptions = {},
	) {}

	update(result: WorkflowRegisteredToolResult | null | undefined, view: WorkflowBlockView): this {
		this.result = result;
		this.view = view;
		const runId = result?.action === "run" && "runId" in result && result.runId ? result.runId : undefined;
		if (runId !== this.followedRunId) {
			this.stopFollowing();
			this.followedRunId = runId;
			this.lastRun = undefined;
		}
		this.refreshRun();
		if (runId !== undefined && this.unsubscribe === undefined && !this.runEnded()) this.follow(runId);
		this.shown = this.signature();
		return this;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private refreshRun(): void {
		if (this.followedRunId === undefined || this.source === undefined) return;
		const run = this.source.run(this.followedRunId);
		if (run !== undefined) this.lastRun = run;
	}

	private runEnded(): boolean {
		return this.lastRun !== undefined && TERMINAL_RUN_STATUSES.has(this.lastRun.status);
	}

	private follow(runId: string): void {
		if (this.source === undefined) return;
		const source = this.source;
		this.unsubscribe = source.subscribeInvalidation((changes) => {
			if (changes !== undefined && !this.touches(runId, changes)) return;
			this.refreshRun();
			if (this.runEnded()) this.stopFollowing();
			const next = this.signature();
			if (next === this.shown) return;
			this.shown = next;
			this.view.invalidate?.();
		});
	}

	private touches(runId: string, changes: readonly { readonly runId: string }[]): boolean {
		if (changes.some((change) => change.runId === runId)) return true;
		const children = new Set(this.source?.childRuns(runId).map((child) => child.id) ?? []);
		return changes.some((change) => children.has(change.runId));
	}

	private stopFollowing(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private summary(): WorkflowResultSummary {
		if (this.view.partial === true && (this.result === null || this.result === undefined)) {
			return { tone: "running", text: "Starting" };
		}
		const now = this.now();
		const run = this.lastRun;
		return summarizeWorkflowResult(this.result, {
			...(this.view.isError && this.view.errorText !== undefined ? { errorText: this.view.errorText } : {}),
			...(run === undefined ? {} : { run, tokens: runTokens(this.source, run, now) }),
			now,
		});
	}

	private signature(): string {
		const summary = this.summary();
		const stages = this.view.expanded ? (this.lastRun?.stages.map((stage) => stage.status).join(",") ?? "") : "";
		return `${summary.tone}\u0000${summary.text}\u0000${stages}`;
	}

	private hint(summary: WorkflowResultSummary): string {
		const hints: string[] = [];
		if (summary.tone === "running" && this.options.agentPanel === true && this.followedRunId !== undefined) {
			const manage = keyHintIfBound("app.agents.focus", "to manage");
			if (manage) hints.push(manage);
		}
		if (!this.view.expanded) {
			const expand = keyHintIfBound("app.tools.expand", "to expand");
			if (expand) hints.push(expand);
		}
		return hints.length === 0
			? ""
			: ` ${this.theme.fg("muted", "(")}${hints.join(this.theme.fg("muted", " · "))}${this.theme.fg("muted", ")")}`;
	}

	private detailLines(width: number): string[] {
		const result = this.result;
		if (result === null || result === undefined || typeof result.action !== "string") {
			const text = this.view.errorText ?? "";
			return text
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0 && !/^\s+at\s/.test(line))
				.map((line) => displayLine(line));
		}
		if (result.action === "run" && !("code" in result)) {
			return runDetailLines(this.lastRun, result, this.view.args, this.theme, this.now());
		}
		return renderResult(result, { width: Math.max(1, width), now: this.now() }).split("\n");
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const summary = this.summary();
		const marker = TONE_MARKERS[summary.tone];
		const glyph = marker.glyph === "" ? "" : `${this.theme.fg(marker.color, marker.glyph)} `;
		const text = summary.tone === "info" ? this.theme.fg("dim", summary.text) : summary.text;
		const head = `${this.theme.fg("dim", FIRST_PREFIX)}${glyph}${text}${this.hint(summary)}`;
		const lines = [truncateToWidth(head, width, "…")];
		if (!this.view.expanded) return lines;
		const innerWidth = Math.max(1, width - DETAIL_PREFIX.length);
		for (const line of this.detailLines(innerWidth)) {
			for (const wrapped of wrapTextWithAnsi(line, innerWidth)) {
				lines.push(truncateToWidth(`${DETAIL_PREFIX}${wrapped}`, width, "…"));
			}
		}
		return lines;
	}

	invalidate(): void {}

	includes(searchString: string): boolean {
		return this.render(160).join("\n").includes(searchString);
	}

	dispose(): void {
		this.stopFollowing();
	}
}

/** The call header, in the tool title style every tool's header uses. */
export function styledCallLine(label: WorkflowCallLabel, theme: WorkflowBlockTheme): string {
	if (label.run) {
		const detail = label.detail === undefined ? "" : theme.fg("muted", ` · ${label.detail}`);
		return `${theme.fg("toolTitle", theme.bold(label.title))}(${theme.fg("accent", label.target ?? "?")}${detail})`;
	}
	const [word, action] = label.title.split(" ");
	const target =
		label.target === undefined ? "" : ` ${theme.fg(action === "status" ? "dim" : "accent", label.target)}`;
	return `${theme.fg("toolTitle", theme.bold(`${word} `))}${action ?? ""}${target}`;
}

export function callComponent(line: string): PiRenderComponent {
	return {
		render: (width: number) => (width < 1 ? [] : wrapTextWithAnsi(line, width)),
		invalidate() {},
		includes: (searchString: string) => line.includes(searchString),
	};
}

export { runAskLine };
