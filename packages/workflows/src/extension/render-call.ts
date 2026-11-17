/**
 * The workflow tool call's header, as every tool shows its call: `Workflow(<name> · <what it was asked>)` for a run,
 * like `Agent(<agent> · <task>)`, and `workflow <action> <target>` for the other actions, like `subagent <action>`.
 */

import { stripVTControlCharacters } from "node:util";
import type { WorkflowInputValues } from "../shared/types.js";
import { truncateToWidth } from "../tui/text-helpers.js";

/** Renderer-only subset of the canonical WorkflowToolArgs from index.ts. */
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

/** The header's parts: `title`, then `target` and `detail` inside parentheses for a run, after a space otherwise. */
export interface WorkflowCallLabel {
	readonly title: string;
	readonly target?: string;
	readonly detail?: string;
	readonly run: boolean;
}

/** The input keys that usually say what a run was asked to do, in the order they are preferred. */
const ASK_INPUT_KEYS = ["prompt", "objective", "task", "goal", "request", "question", "description"] as const;
const ASK_DETAIL_LIMIT = 100;

/** One line of display text: no terminal controls, no line breaks. */
export function displayLine(value: string): string {
	return stripVTControlCharacters(value)
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

/** The first line of the input that says what the run was asked to do: a preferred key, else the first text input. */
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
	return line === undefined ? undefined : truncateToWidth(line, ASK_DETAIL_LIMIT, "…");
}

function actionTarget(args: WorkflowToolArgs): string | undefined {
	const target = nonEmpty(args.runId) ?? nonEmpty(args.workflow);
	const stage = nonEmpty(args.stageId);
	if (target !== undefined && stage !== undefined) return `${target}/${stage}`;
	return target ?? stage;
}

/** What the header says for these arguments. */
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

export interface RenderCallOpts {
	/** Optional host render width in terminal cells. */
	width?: number;
}

/** The header as plain text, as a log or a screen reader reads it. */
export function renderCall(args: WorkflowToolArgs, opts: RenderCallOpts = {}): string {
	const label = workflowCallLabel(args);
	const line = label.run
		? `${label.title}(${label.target ?? "?"}${label.detail === undefined ? "" : ` · ${label.detail}`})`
		: `${label.title}${label.target === undefined ? "" : ` ${label.target}`}`;
	return opts.width === undefined || opts.width <= 0 ? line : truncateToWidth(line, opts.width, "…");
}
