import { stripVTControlCharacters } from "node:util";
import type { WorkflowInputValues } from "../shared/types.js";
import { inertDisplayLine } from "../tui/display-text.js";
import { truncateToWidth, visibleWidth } from "../tui/text-helpers.js";

function plainTruncate(text: string, width: number, suffix = "…"): string {
	return stripVTControlCharacters(truncateToWidth(text, width, suffix));
}

export interface WorkflowToolArgs {
	workflow?: string;
	inputs?: WorkflowInputValues;
	action?:
		| "models"
		| "run"
		| "list"
		| "get"
		| "status"
		| "stages"
		| "stage"
		| "transcript"
		| "answer"
		| "pause"
		| "quit"
		| "resume"
		| "fork"
		| "reload"
		| "inputs";
	runId?: string;
	stageId?: string;
}

export interface WorkflowCallLabel {
	readonly title: string;
	readonly target?: string;
	readonly detail?: string;
	readonly run: boolean;
}

const ASK_INPUT_KEYS = ["prompt", "objective", "task", "goal", "request", "question", "description"] as const;
const ASK_DETAIL_LIMIT = 160;

export function displayLine(value: string): string {
	return inertDisplayLine(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const line = displayLine(value);
	return line.length > 0 ? line : undefined;
}

function firstLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const shown = nonEmpty(line);
		if (shown !== undefined) return shown;
	}
	return undefined;
}

export function runAskLine(inputs: WorkflowInputValues | undefined): string | undefined {
	if (inputs === undefined || inputs === null || typeof inputs !== "object") return undefined;
	const values = inputs as Readonly<Record<string, unknown>>;
	const preferred = ASK_INPUT_KEYS.map((key) => values[key]).find(
		(value): value is string => typeof value === "string" && firstLine(value) !== undefined,
	);
	const text =
		preferred ??
		Object.values(values).find(
			(value): value is string => typeof value === "string" && firstLine(value) !== undefined,
		);
	if (text === undefined) return undefined;
	const line = firstLine(text);
	return line === undefined ? undefined : plainTruncate(line, ASK_DETAIL_LIMIT, "…");
}

function actionTarget(args: WorkflowToolArgs): string | undefined {
	const target = nonEmpty(args.runId) ?? nonEmpty(args.workflow);
	const stage = nonEmpty(args.stageId);
	if (target !== undefined && stage !== undefined) return `${target}/${stage}`;
	return target ?? stage;
}

export function workflowCallLabel(args: WorkflowToolArgs): WorkflowCallLabel {
	const action = args.action ?? "run";
	if (action === "run") {
		const target = nonEmpty(args.workflow) ?? "?";
		const detail = runAskLine(args.inputs);
		return { title: "Workflow", target, ...(detail === undefined ? {} : { detail }), run: true };
	}
	const target = actionTarget(args);
	return { title: `workflow ${action}`, ...(target === undefined ? {} : { target }), run: false };
}

export function fitWorkflowCallLabel(label: WorkflowCallLabel, width?: number): WorkflowCallLabel {
	if (width === undefined || width <= 0 || !label.run) return label;
	const target = label.target ?? "?";
	const detail = label.detail;
	const innerBudget = width - visibleWidth(label.title) - 2;
	if (innerBudget < 1) return label;
	const fullInnerWidth = visibleWidth(target) + (detail === undefined ? 0 : 3 + visibleWidth(detail));
	if (fullInnerWidth <= innerBudget) return label;
	if (detail !== undefined && visibleWidth(target) + 4 <= innerBudget) {
		return {
			...label,
			target,
			detail: plainTruncate(detail, innerBudget - visibleWidth(target) - 3, "…"),
		};
	}
	return {
		title: label.title,
		target: plainTruncate(target, innerBudget, "…"),
		run: true,
	};
}

export interface RenderCallOpts {
	width?: number;
}

export function renderCall(args: WorkflowToolArgs, opts: RenderCallOpts = {}): string {
	const rawLabel = workflowCallLabel(args);
	const label = fitWorkflowCallLabel(rawLabel, opts.width);
	const line = label.run
		? `${label.title}(${label.target ?? "?"}${label.detail === undefined ? "" : ` · ${label.detail}`})`
		: `${label.title}${label.target === undefined ? "" : ` ${label.target}`}`;
	return opts.width === undefined || opts.width <= 0 ? line : plainTruncate(line, opts.width, "…");
}
