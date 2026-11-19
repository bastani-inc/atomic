import type { ThemeColor } from "@bastani/atomic";
import { keyHintIfBound, navEntryKeys, sliceHead, ToolBlock, ToolBlockRecords } from "@bastani/atomic";
import {
	type Component,
	clickableKeyTextHint,
	getKeybindings,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { meter_run, type RunUsageTree } from "../shared/budget-meter.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { StoreInvalidationListener } from "../shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot, StageStatus } from "../shared/store-types.js";
import { stripTerminalSequences } from "../shared/terminal-controls.js";
import { elapsedRunMs } from "../shared/timing.js";
import { boundedToolText, TOOL_PAYLOAD_VALUE_LIMIT } from "../shared/tool-payload-bounds.js";
import type { WorkflowOutputValues } from "../shared/types.js";
import { authoritativeWorkflowChildRunId, type RunsById } from "../shared/workflow-run-ownership.js";
import { inertDisplayLine, summarizeFailureText, withoutStackFrames } from "../tui/display-text.js";
import { findWaitingInTree, runFailureText, validChildRunForStage } from "../tui/run-display-state.js";
import { truncateToWidth } from "../tui/text-helpers.js";
import type { PiRenderComponent } from "./public-types.js";
import {
	displayLine,
	fitWorkflowCallLabel,
	runAskLine,
	type WorkflowCallLabel,
	type WorkflowToolArgs,
	workflowCallLabel,
} from "./render-call.js";
import type { WorkflowRegisteredToolResult } from "./render-result.js";
import { renderResult } from "./render-result.js";

export interface WorkflowBlockTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

const PLAIN_THEME: WorkflowBlockTheme = { fg: (_color, text) => text, bold: (text) => text };

export function workflowBlockTheme(theme: unknown): WorkflowBlockTheme {
	const candidate = theme as Partial<WorkflowBlockTheme> | undefined;
	return typeof candidate?.fg === "function" && typeof candidate.bold === "function"
		? {
				fg: (color, text) => candidate.fg!(color, text),
				bold: (text) => candidate.bold!(text),
			}
		: PLAIN_THEME;
}

export interface WorkflowRunSource {
	run(runId: string): RunSnapshot | undefined;
	childRuns(parentRunId: string): readonly RunSnapshot[];
	subscribeInvalidation(listener: StoreInvalidationListener): () => void;
}

export type WorkflowResultTone =
	| "running"
	| "success"
	| "failure"
	| "warning"
	| "paused"
	| "waiting"
	| "stopped"
	| "info";

export interface WorkflowResultSummary {
	readonly tone: WorkflowResultTone;
	readonly text: string;
}

/**
 * A stage released while it waits is not paused: it shows the still, dim mark a subagent released while it waits has
 * in its notice, `/tasks` and the agent panel.
 */
const WAITING_MARKER = { glyph: "◌", color: "dim" } as const;

const TONE_MARKERS: Readonly<Record<WorkflowResultTone, { readonly glyph: string; readonly color: ThemeColor }>> = {
	running: { glyph: "", color: "accent" },
	success: { glyph: "✓", color: "success" },
	failure: { glyph: "✗", color: "error" },
	warning: { glyph: "!", color: "warning" },
	paused: { glyph: "⏸", color: "muted" },
	waiting: WAITING_MARKER,
	stopped: { glyph: "◼", color: "muted" },
	info: { glyph: "", color: "dim" },
};

const STAGE_MARKERS: Readonly<Record<WorkflowResultTone, { readonly glyph: string; readonly color: ThemeColor }>> = {
	running: { glyph: "∀", color: "accent" },
	success: { glyph: "✓", color: "success" },
	failure: { glyph: "✗", color: "error" },
	warning: { glyph: "!", color: "warning" },
	paused: { glyph: "⏸", color: "muted" },
	waiting: WAITING_MARKER,
	stopped: { glyph: "◼", color: "muted" },
	info: { glyph: "·", color: "dim" },
};

const STAGE_TONES: Readonly<Record<StageStatus, WorkflowResultTone>> = {
	pending: "info",
	running: "running",
	awaiting_input: "warning",
	paused: "paused",
	blocked: "warning",
	suspended: "waiting",
	completed: "success",
	failed: "failure",
	skipped: "stopped",
};

const FINAL_UNRESUMABLE_RUN_STATUSES = new Set<RunSnapshot["status"]>(["completed", "skipped", "cancelled", "killed"]);

const SETTLED_STAGE_STATUSES = new Set<StageStatus>(["completed", "failed", "skipped"]);
const FIRST_PREFIX = "  ⎿  ";
const DETAIL_PREFIX = "     ";
const LIST_PREVIEW = 3;
const ERROR_SCAN_LIMIT = 4096;
const ERROR_PREVIEW_LIMIT = 240;
const DEFAULT_DEFINITION_GUIDANCE = "Fix the workflow definition and run /reload.";

export function formatBlockDuration(ms: number): string {
	const totalSec = Math.floor(Math.max(0, ms) / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function formatWorkflowTokenCount(tokens: number): string {
	const count = Math.max(0, Math.round(tokens));
	if (count < 1000) return `${count}`;
	if (count < 999_500) return `${(count / 1000).toFixed(count < 99_950 ? 1 : 0)}k`;
	if (count < 999_500_000) return `${(count / 1_000_000).toFixed(count < 99_950_000 ? 1 : 0)}m`;
	return `${(count / 1_000_000_000).toFixed(count < 99_950_000_000 ? 1 : 0)}b`;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : nouns}`;
}

export function shortReason(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const first = withoutStackFrames(sliceHead(text, ERROR_SCAN_LIMIT)).kept.find(
		(line) => displayLine(line).length > 0,
	);
	if (first === undefined) return undefined;
	const reason = summarizeFailureText(first).reason;
	return reason.length > ERROR_PREVIEW_LIMIT ? `${sliceHead(reason, ERROR_PREVIEW_LIMIT - 1)}…` : reason;
}

function shortPrompt(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const line = displayLine(sliceHead(text, ERROR_SCAN_LIMIT));
	if (line.length === 0) return undefined;
	return line.length > ERROR_PREVIEW_LIMIT ? `${sliceHead(line, ERROR_PREVIEW_LIMIT - 1)}…` : line;
}

function runsByIdFromSource(source: Pick<WorkflowRunSource, "run"> | undefined, rootRun: RunSnapshot): RunsById {
	return {
		get: (runId) => (runId === rootRun.id ? (source?.run(runId) ?? rootRun) : source?.run(runId)),
	};
}

function descendantRunIds(
	source: WorkflowRunSource | undefined,
	runId: string,
	rootRun: RunSnapshot | undefined,
): Set<string> {
	const ids = new Set<string>();
	if (source === undefined) return ids;
	const resolvedRoot = rootRun ?? source.run(runId);
	const runsById = resolvedRoot === undefined ? undefined : runsByIdFromSource(source, resolvedRoot);
	const visited = new Set<string>([runId]);
	const queue: Array<{ readonly id: string; readonly run: RunSnapshot | undefined }> = [
		{ id: runId, run: resolvedRoot },
	];
	for (let index = 0; index < queue.length; index++) {
		const current = queue[index]!;
		if (current.run !== undefined && runsById !== undefined) {
			for (const stage of current.run.stages) {
				const validChild = validChildRunForStage(stage, current.run, runId, runsById, visited);
				if (validChild !== undefined && !ids.has(validChild.id) && validChild.id !== runId) {
					ids.add(validChild.id);
					queue.push({ id: validChild.id, run: validChild });
					continue;
				}
				const childId = authoritativeWorkflowChildRunId(stage);
				if (childId !== undefined && !ids.has(childId) && childId !== runId) {
					ids.add(childId);
					queue.push({ id: childId, run: source.run(childId) });
				}
			}
		}
		for (const child of source.childRuns(current.id)) {
			if (child.parentStageId !== undefined && current.run !== undefined) continue;
			if (!ids.has(child.id) && child.id !== runId) {
				ids.add(child.id);
				queue.push({ id: child.id, run: child });
			}
		}
	}
	return ids;
}

function join(...parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}

function usageTree(source: WorkflowRunSource | undefined, run: RunSnapshot, visited = new Set<string>()): RunUsageTree {
	if (source === undefined || visited.has(run.id)) return { run, children: [] };
	visited.add(run.id);
	const seenChildren = new Set<string>();
	const children: RunSnapshot[] = [];
	for (const child of source.childRuns(run.id)) {
		if (!visited.has(child.id) && !seenChildren.has(child.id)) {
			seenChildren.add(child.id);
			children.push(child);
		}
	}
	for (const stage of run.stages) {
		const childId = authoritativeWorkflowChildRunId(stage);
		if (childId === undefined || visited.has(childId) || seenChildren.has(childId)) continue;
		const child = source.run(childId);
		if (child !== undefined) {
			seenChildren.add(child.id);
			children.push(child);
		}
	}
	return { run, children: children.map((child) => usageTree(source, child, visited)) };
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
	if (stage !== undefined) return displayLine(stage.name);
	const tool =
		run.failedToolNodeId === undefined ? undefined : run.toolNodes.find((node) => node.id === run.failedToolNodeId);
	return tool === undefined ? undefined : displayLine(tool.name);
}

function stageProgress(run: { readonly stages: readonly StageSnapshot[] }): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const settled = run.stages.filter((stage) => SETTLED_STAGE_STATUSES.has(stage.status)).length;
	return `${settled}/${total} stages`;
}

function completedStageProgress(run: { readonly stages: readonly StageSnapshot[] }): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const completed = run.stages.filter((stage) => stage.status === "completed").length;
	return `${completed}/${total} stages`;
}

function runningStageProgress(run: RunSnapshot): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const current = stageWhere(
		run,
		(stage) =>
			stage.status === "running" ||
			stage.status === "awaiting_input" ||
			stage.status === "paused" ||
			stage.status === "blocked",
	);
	const settled = run.stages.filter((stage) => SETTLED_STAGE_STATUSES.has(stage.status)).length;
	const index = current !== undefined ? run.stages.indexOf(current) + 1 : Math.min(total, Math.max(1, settled));
	const name = current !== undefined ? displayLine(current.name) : "";
	return `stage ${index}/${total}${name ? ` ${name}` : ""}`;
}

function pausedStageProgress(run: RunSnapshot): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const current = stageWhere(run, (stage) => stage.status === "paused" || stage.status === "running");
	const settled = run.stages.filter((stage) => SETTLED_STAGE_STATUSES.has(stage.status)).length;
	const index = current !== undefined ? run.stages.indexOf(current) + 1 : Math.min(total, Math.max(1, settled));
	return `stage ${index}/${total}`;
}

function manageKeyLabel(): string | undefined {
	const keys = getKeybindings();
	if (typeof keys.getKeys !== "function") return "↓";
	const bound = keys.getKeys("app.agents.focus");
	if (bound.length > 0) return navEntryKeys(keys, { action: "app.agents.focus", label: "to manage" });
	const hasAppBindings = keys.getKeys("app.tools.expand").length > 0 || keys.getKeys("app.interrupt").length > 0;
	return hasAppBindings ? undefined : "↓";
}

function manageHintSegment(enabled = true): string | undefined {
	if (!enabled) return undefined;
	const key = manageKeyLabel();
	return key ? clickableKeyTextHint(key, " to manage") : undefined;
}

export interface DefinitionErrorView {
	readonly message: string;
	readonly sourceLine?: string;
	readonly caretLine?: string;
	readonly guidance: string;
}

const CARET_LINE_RE = /^(\s*(?:\|\s*)?\^+)\s*$/;
const DEFINITION_ERROR_RE =
	/^(?:Uncaught\s+)?(?:Definition\s+error|DefinitionError)\s*:|Failed to import|ParseError|SyntaxError|TransformError|INVALID_DEFINITION|IMPORT_FAILED|__piWorkflow|workflow\(\{|workflow:\s+(?:description|run|outputs|inputs|name|normalized name|heartbeatIntervalMinutes|budget)\b/i;

function sanitizePreservingIndent(line: string): string {
	return inertDisplayLine(stripTerminalSequences(line, true).replace(/\t/g, "  ")).trimEnd();
}

export function parseDefinitionError(rawText: string | undefined): DefinitionErrorView | undefined {
	if (rawText === undefined || rawText.trim().length === 0) return undefined;
	const bounded = sliceHead(rawText, ERROR_SCAN_LIMIT);
	const { kept } = withoutStackFrames(bounded);
	const nonEmptyLines = kept.filter((line) => displayLine(line).length > 0);
	if (nonEmptyLines.length === 0) return undefined;
	const hasCaret = nonEmptyLines.some((line) => CARET_LINE_RE.test(stripTerminalSequences(line, true)));
	if (!hasCaret && !DEFINITION_ERROR_RE.test(bounded)) return undefined;

	const firstRaw = displayLine(nonEmptyLines[0]!);
	const withoutImport = firstRaw.replace(/^Failed to import "[^"]*":\s*/i, "");
	const strippedMessage = withoutImport
		.replace(
			/^(?:Uncaught\s+)?(?:Definition\s+error|DefinitionError|Error|TypeError|SyntaxError|ParseError):\s*/i,
			"",
		)
		.trim();
	const message = strippedMessage.length > 0 ? strippedMessage : withoutImport;

	const rest = nonEmptyLines.slice(1);
	const caretIdx = rest.findIndex((line) => CARET_LINE_RE.test(stripTerminalSequences(line, true)));
	let sourceLine: string | undefined;
	let caretLine: string | undefined;
	let guidance: string | undefined;

	if (caretIdx >= 0) {
		const rawCaret = sanitizePreservingIndent(rest[caretIdx]!);
		const rawSource = caretIdx > 0 ? sanitizePreservingIndent(rest[caretIdx - 1]!) : undefined;
		if (rawSource !== undefined) {
			const gutterMatch = /^(\s*\d+\s*\|\s?)/.exec(rawSource);
			const caretGutterMatch = /^(\s*\|\s?)/.exec(rawCaret);
			if (gutterMatch && caretGutterMatch) {
				sourceLine = rawSource.slice(gutterMatch[1]!.length);
				caretLine = rawCaret.slice(caretGutterMatch[1]!.length);
			} else {
				const leadSpaces = /^\s*/.exec(rawSource)?.[0].length ?? 0;
				sourceLine = rawSource.slice(leadSpaces);
				caretLine = rawCaret.slice(Math.min(leadSpaces, /^\s*/.exec(rawCaret)?.[0].length ?? 0));
			}
		} else {
			caretLine = rawCaret;
		}
		const afterCaret = rest.slice(caretIdx + 1).find((line) => displayLine(line).length > 0);
		if (afterCaret !== undefined) guidance = displayLine(afterCaret);
	} else if (rest.length > 0) {
		guidance = displayLine(rest[rest.length - 1]!);
	}

	return {
		message: message.length > ERROR_PREVIEW_LIMIT ? `${sliceHead(message, ERROR_PREVIEW_LIMIT - 1)}…` : message,
		...(sourceLine === undefined ? {} : { sourceLine }),
		...(caretLine === undefined ? {} : { caretLine }),
		guidance: guidance ?? DEFAULT_DEFINITION_GUIDANCE,
	};
}

export function summarizeRun(
	run: RunSnapshot,
	tokens: number,
	now: number,
	manage = true,
	runsById?: RunsById,
): WorkflowResultSummary {
	const elapsedMs = elapsedRunMs(run, now);
	const elapsed = elapsedMs >= 1000 ? formatBlockDuration(elapsedMs) : undefined;
	const tokenText = tokens > 0 ? `${formatWorkflowTokenCount(tokens)} tokens` : undefined;
	const hasDuration = elapsedMs > 0 || run.endedAt !== undefined || run.durationMs !== undefined;
	const status = effectiveRunStatus(run);
	switch (status) {
		case "pending":
		case "running": {
			const waiting = findWaitingInTree(run, runsById);
			if (waiting !== undefined) {
				const where = waiting.stageName === undefined ? "" : ` at ${displayLine(waiting.stageName)}`;
				return {
					tone: "warning",
					text: join(
						`Waiting for input${where}`,
						runningStageProgress(run),
						elapsed,
						shortPrompt(waiting.question),
						manageHintSegment(manage),
					),
				};
			}
			return {
				tone: "running",
				text: join(
					"Running in background",
					runningStageProgress(run),
					elapsed,
					tokens > 0 ? `↓ ${formatWorkflowTokenCount(tokens)} tokens` : undefined,
					manageHintSegment(manage),
				),
			};
		}
		case "paused": {
			if (run.exitReason === "quit" || run.quitAt !== undefined) {
				const stoppedDuration =
					hasDuration || run.pausedAt !== undefined || run.quitAt !== undefined
						? `Stopped in ${formatBlockDuration(elapsedMs)}`
						: "Stopped";
				return {
					tone: "stopped",
					text: join(stoppedDuration, completedStageProgress(run), tokenText),
				};
			}
			return {
				tone: "paused",
				text: join("Paused", pausedStageProgress(run), manageHintSegment(manage)),
			};
		}
		case "completed":
			return {
				tone: "success",
				text: join(
					`Completed in ${formatBlockDuration(elapsedMs)}`,
					run.stages.length > 0 ? plural(run.stages.length, "stage") : undefined,
					tokenText,
				),
			};
		case "failed": {
			const stage = failedStageName(run);
			return {
				tone: "failure",
				text: join(
					hasDuration ? `Failed in ${formatBlockDuration(elapsedMs)}` : "Failed",
					stage === undefined ? undefined : `stage ${stage}`,
					completedStageProgress(run),
					tokenText,
					shortReason(runFailureText(run) ?? run.exitReason),
				),
			};
		}
		case "blocked": {
			const stage =
				(run.failedStageId === undefined ? undefined : stageWhere(run, (s) => s.id === run.failedStageId)) ??
				stageWhere(run, (s) => s.status === "blocked" || s.status === "failed");
			return {
				tone: "warning",
				text: join(
					stage === undefined ? "Blocked" : `Blocked at ${displayLine(stage.name)}`,
					completedStageProgress(run),
					shortReason(runFailureText(run) ?? run.exitReason),
				),
			};
		}
		case "skipped":
			return { tone: "stopped", text: join("Skipped", shortReason(run.exitReason)) };
		default:
			return {
				tone: "stopped",
				text: join(
					hasDuration ? `Stopped in ${formatBlockDuration(elapsedMs)}` : "Stopped",
					completedStageProgress(run),
					tokenText,
				),
			};
	}
}

function summarizeRunResult(
	result: Extract<WorkflowRegisteredToolResult, { action: "run" }>,
	manage = true,
): WorkflowResultSummary {
	if ("code" in result) return { tone: "failure", text: shortReason(result.error) ?? "Timed out" };
	const status = result.details?.status === "accepted" ? "running" : result.status;
	if (result.error !== undefined && result.error.length > 0) {
		const defError = !result.runId ? parseDefinitionError(result.error) : undefined;
		if (defError !== undefined) {
			return { tone: "failure", text: `Definition error: ${defError.message}` };
		}
		return { tone: "failure", text: join(result.runId ? "Failed" : "Not started", shortReason(result.error)) };
	}
	switch (status) {
		case "running":
		case "pending":
		case "accepted":
			return {
				tone: "running",
				text: join(
					"Running in background",
					result.runId ? `run ${displayLine(result.runId)}` : undefined,
					manageHintSegment(manage),
				),
			};
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
			return { tone: "paused", text: join("Paused", manageHintSegment(manage)) };
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

export function summarizeWorkflowResult(
	result: WorkflowRegisteredToolResult | null | undefined,
	view: {
		readonly errorText?: string;
		readonly run?: RunSnapshot;
		readonly runsById?: RunsById;
		readonly tokens?: number;
		readonly now: number;
		readonly manage?: boolean;
	},
): WorkflowResultSummary {
	if (result === null || result === undefined || typeof result.action !== "string") {
		const defError = parseDefinitionError(view.errorText);
		if (defError !== undefined) return { tone: "failure", text: `Definition error: ${defError.message}` };
		const reason = shortReason(view.errorText);
		return reason === undefined ? { tone: "info", text: "No result" } : { tone: "failure", text: reason };
	}
	if ("code" in result && result.code === "WORKFLOW_TIMEOUT") {
		return { tone: "failure", text: shortReason(result.error) ?? "Timed out" };
	}
	switch (result.action) {
		case "run":
			return view.run !== undefined
				? summarizeRun(view.run, view.tokens ?? 0, view.now, view.manage !== false, view.runsById)
				: summarizeRunResult(
						result as Extract<WorkflowRegisteredToolResult, { action: "run" }>,
						view.manage !== false,
					);
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
	const marker = STAGE_MARKERS[STAGE_TONES[stage.status]];
	const ended = stage.endedAt ?? (stage.status === "running" ? now : undefined);
	const duration =
		stage.durationMs !== undefined
			? formatBlockDuration(stage.durationMs)
			: stage.startedAt !== undefined && ended !== undefined
				? formatBlockDuration(ended - stage.startedAt)
				: undefined;
	const reason = stage.status === "failed" || stage.status === "blocked" ? shortReason(stage.error) : undefined;
	return `  ${theme.fg(marker.color, marker.glyph)} ${join(displayLine(stage.name), stage.status === "completed" ? undefined : stage.status.replaceAll("_", " "), duration, reason)}`;
}

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
	if (runId) lines.push(theme.fg("dim", `run ${displayLine(runId)} · /workflows`));
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
	readonly agentPanel?: boolean;
	readonly now?: () => number;
}

function definitionErrorRecordComponent(defError: DefinitionErrorView, theme: WorkflowBlockTheme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width < 1) return [];
			const lines = [truncateToWidth(theme.fg("error", `Definition error: ${defError.message}`), width, "…")];
			if (defError.sourceLine !== undefined) {
				lines.push(truncateToWidth(defError.sourceLine, width, "…"));
			}
			if (defError.caretLine !== undefined) {
				lines.push(truncateToWidth(theme.fg("error", defError.caretLine), width, "…"));
			}
			lines.push(truncateToWidth(theme.fg("dim", defError.guidance), width, "…"));
			return lines;
		},
	};
}

export class WorkflowDefinitionFailureBlock extends ToolBlock implements PiRenderComponent {
	constructor(label: WorkflowCallLabel, defError: DefinitionErrorView, theme: WorkflowBlockTheme, outputPad?: number) {
		super({
			status: "failure",
			title: callComponent(label, theme),
			details: new ToolBlockRecords([definitionErrorRecordComponent(defError, theme)]),
			...(outputPad === undefined ? {} : { outputPad }),
		});
	}

	isWorking(): boolean {
		return false;
	}

	includes(searchString: string): boolean {
		return this.render(160).join("\n").includes(searchString);
	}
}

export class WorkflowToolResultBlock extends ToolBlockRecords implements PiRenderComponent {
	private result: WorkflowRegisteredToolResult | null | undefined;
	private view: WorkflowBlockView = { expanded: false, isError: false };
	private followedRunId: string | undefined;
	private unsubscribe: (() => void) | undefined;
	private lastRun: RunSnapshot | undefined;
	private trackedRunIds = new Set<string>();
	private shown: string | undefined;
	private working = false;
	private disposed = false;

	constructor(
		private readonly source: WorkflowRunSource | undefined,
		private readonly theme: WorkflowBlockTheme,
		private readonly renderOptions: WorkflowBlockOptions = {},
	) {
		super([]);
	}

	update(result: WorkflowRegisteredToolResult | null | undefined, view: WorkflowBlockView): this {
		this.disposed = false;
		this.result = result;
		this.view = view;
		const runId = result?.action === "run" && "runId" in result && result.runId ? result.runId : undefined;
		if (runId !== this.followedRunId) {
			this.stopFollowing();
			this.followedRunId = runId;
			this.lastRun = undefined;
			this.trackedRunIds.clear();
		}
		this.refreshRun();
		this.working = this.computeWorking();
		if (runId !== undefined && this.unsubscribe === undefined && !this.runEnded()) this.follow(runId);
		this.shown = this.signature();
		return this;
	}

	isWorking(): boolean {
		return this.working;
	}

	definitionFailureBlock(outputPad?: number): WorkflowDefinitionFailureBlock | undefined {
		const defError = this.definitionError();
		if (defError === undefined) return undefined;
		const fallbackName =
			this.result !== null &&
			this.result !== undefined &&
			typeof this.result.action === "string" &&
			this.result.action === "run" &&
			"name" in this.result &&
			typeof this.result.name === "string"
				? this.result.name
				: undefined;
		const label = workflowCallLabel(this.view.args ?? (fallbackName ? { workflow: fallbackName } : {}));
		return new WorkflowDefinitionFailureBlock(label, defError, this.theme, outputPad);
	}

	private computeWorking(): boolean {
		if (this.disposed) return false;
		if (this.view.partial === true && (this.result === null || this.result === undefined)) return true;
		if (this.lastRun !== undefined) {
			const status = effectiveRunStatus(this.lastRun);
			if (status !== "running" && status !== "pending") return false;
			return findWaitingInTree(this.lastRun, runsByIdFromSource(this.source, this.lastRun)) === undefined;
		}
		const result = this.result;
		if (result === null || result === undefined || typeof result.action !== "string" || "code" in result) {
			return false;
		}
		if (result.action === "run") {
			if (result.error !== undefined && result.error.length > 0) return false;
			const status = result.details?.status === "accepted" ? "running" : result.status;
			return status === "running" || status === "pending" || status === "accepted";
		}
		if (result.action === "stage") {
			return result.error === undefined && result.stage?.status === "running";
		}
		return false;
	}

	private now(): number {
		return this.renderOptions.now?.() ?? Date.now();
	}

	private refreshRun(): void {
		if (this.followedRunId === undefined || this.source === undefined) return;
		const run = this.source.run(this.followedRunId);
		if (run !== undefined) this.lastRun = run;
		this.trackedRunIds = descendantRunIds(this.source, this.followedRunId, this.lastRun);
		this.working = this.computeWorking();
	}

	private runEnded(): boolean {
		if (this.lastRun === undefined) return false;
		const status = effectiveRunStatus(this.lastRun);
		if (FINAL_UNRESUMABLE_RUN_STATUSES.has(status)) return true;
		return status === "failed" && this.lastRun.resumable === false;
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
		if (changes.some((change) => change.runId === runId || this.trackedRunIds.has(change.runId))) return true;
		const current = descendantRunIds(this.source, runId, this.lastRun);
		return changes.some((change) => current.has(change.runId));
	}

	private stopFollowing(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private definitionError(): DefinitionErrorView | undefined {
		if (this.lastRun !== undefined) return undefined;
		const result = this.result;
		if (result === null || result === undefined || typeof result.action !== "string") {
			return this.view.isError ? parseDefinitionError(this.view.errorText) : undefined;
		}
		if (result.action === "run" && !("code" in result) && !result.runId && result.error) {
			return parseDefinitionError(result.error);
		}
		return undefined;
	}

	private summary(manage = this.renderOptions.agentPanel !== false): WorkflowResultSummary {
		if (this.view.partial === true && (this.result === null || this.result === undefined)) {
			return { tone: "running", text: "Starting" };
		}
		const now = this.now();
		const run = this.lastRun;
		return summarizeWorkflowResult(this.result, {
			...(this.view.isError && this.view.errorText !== undefined ? { errorText: this.view.errorText } : {}),
			...(run === undefined
				? {}
				: {
						run,
						runsById: runsByIdFromSource(this.source, run),
						tokens: runTokens(this.source, run, now),
					}),
			now,
			manage,
		});
	}

	private signature(): string {
		const summary = this.summary();
		const stages = this.view.expanded ? (this.lastRun?.stages.map((stage) => stage.status).join(",") ?? "") : "";
		return `${summary.tone}\u0000${summary.text}\u0000${stages}`;
	}

	private expandHint(): string {
		if (this.view.expanded) return "";
		const expand = keyHintIfBound("app.tools.expand", "to expand");
		if (!expand) return "";
		return ` ${this.theme.fg("muted", "(")}${expand}${this.theme.fg("muted", ")")}`;
	}

	private detailLines(width: number): string[] {
		const result = this.result;
		if (result === null || result === undefined || typeof result.action !== "string") {
			const text = this.view.errorText ?? "";
			return withoutStackFrames(boundedToolText(text, TOOL_PAYLOAD_VALUE_LIMIT))
				.kept.map((line) => displayLine(line))
				.filter((line) => line.length > 0);
		}
		if (result.action === "run" && !("code" in result)) {
			return runDetailLines(this.lastRun, result, this.view.args, this.theme, this.now());
		}
		return renderResult(result, { width: Math.max(1, width), now: this.now() }).split("\n");
	}

	private renderDefinitionError(defError: DefinitionErrorView, width: number): string[] {
		const record = definitionErrorRecordComponent(defError, this.theme);
		const innerWidth = Math.max(1, width - DETAIL_PREFIX.length);
		return record.render(innerWidth).map((line, index) => {
			const prefix = index === 0 ? `${this.theme.fg("dim", FIRST_PREFIX)}` : DETAIL_PREFIX;
			return truncateToWidth(`${prefix}${line}`, width, "…");
		});
	}

	private formatHead(summary: WorkflowResultSummary): string {
		const marker = TONE_MARKERS[summary.tone];
		const glyph = marker.glyph === "" ? "" : `${this.theme.fg(marker.color, marker.glyph)} `;
		const text = summary.tone === "info" ? this.theme.fg("dim", summary.text) : summary.text;
		return `${this.theme.fg("dim", FIRST_PREFIX)}${glyph}${text}`;
	}

	override render(width: number): string[] {
		if (width < 1) return [];
		const defError = this.definitionError();
		if (defError !== undefined) {
			return this.renderDefinitionError(defError, width);
		}
		const summary = this.summary();
		const head = this.formatHead(summary);
		const withExpandHint = `${head}${this.expandHint()}`;
		let firstLine: string;
		if (visibleWidth(withExpandHint) <= width) {
			firstLine = withExpandHint;
		} else if (visibleWidth(head) <= width) {
			firstLine = head;
		} else {
			const withoutManage = this.summary(false);
			const bareHead = this.formatHead(withoutManage);
			firstLine = visibleWidth(bareHead) <= width ? bareHead : truncateToWidth(bareHead, width, "…");
		}
		const lines = [firstLine];
		if (!this.view.expanded) return lines;
		const innerWidth = Math.max(1, width - DETAIL_PREFIX.length);
		for (const line of this.detailLines(innerWidth)) {
			for (const wrapped of wrapTextWithAnsi(line, innerWidth)) {
				lines.push(truncateToWidth(`${DETAIL_PREFIX}${wrapped}`, width, "…"));
			}
		}
		return lines;
	}

	override invalidate(): void {}

	includes(searchString: string): boolean {
		return this.render(160).join("\n").includes(searchString);
	}

	dispose(): void {
		this.disposed = true;
		this.working = false;
		this.stopFollowing();
	}
}

export function styledCallLine(label: WorkflowCallLabel, theme: WorkflowBlockTheme, width?: number): string {
	const fitted = fitWorkflowCallLabel(label, width);
	if (fitted.run) {
		const detail = fitted.detail === undefined ? "" : theme.fg("muted", ` · ${fitted.detail}`);
		const line = `${theme.fg("toolTitle", theme.bold(fitted.title))}(${theme.fg("accent", fitted.target ?? "?")}${detail})`;
		return width !== undefined && width > 0 ? truncateToWidth(line, width, "…") : line;
	}
	const [word, action] = fitted.title.split(" ");
	const target =
		fitted.target === undefined ? "" : ` ${theme.fg(action === "status" ? "dim" : "accent", fitted.target)}`;
	const line = `${theme.fg("toolTitle", theme.bold(`${word} `))}${action ?? ""}${target}`;
	return width !== undefined && width > 0 ? truncateToWidth(line, width, "…") : line;
}

function fitCallLineString(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	const plain = stripTerminalSequences(line, true);
	if (plain.startsWith("Workflow(") && plain.endsWith(")") && width >= 11) {
		const closingIndex = line.lastIndexOf(")");
		if (closingIndex > 0) {
			const prefixAndArgs = line.slice(0, closingIndex);
			const suffix = line.slice(closingIndex);
			return `${truncateToWidth(prefixAndArgs, width - 1, "…")}${suffix}`;
		}
	}
	return truncateToWidth(line, width, "…");
}

export function callComponent(
	labelOrLine: WorkflowCallLabel | string,
	theme: WorkflowBlockTheme = PLAIN_THEME,
): PiRenderComponent & Component {
	if (typeof labelOrLine !== "string") {
		const full = styledCallLine(labelOrLine, theme);
		return {
			render: (width: number) => (width < 1 ? [] : [styledCallLine(labelOrLine, theme, width)]),
			invalidate() {},
			includes: (searchString: string) => full.includes(searchString),
		};
	}
	return {
		render: (width: number) => (width < 1 ? [] : [fitCallLineString(labelOrLine, width)]),
		invalidate() {},
		includes: (searchString: string) => labelOrLine.includes(searchString),
	};
}

export { runAskLine };
