/**
 * Transcript presentation for shell task results: a `wait` observation and a `kill` receipt each become one status
 * line, with the task's output (when it has any) below it. Raw observation envelopes and internal ids never appear.
 *
 * Roles follow DESIGN.md: success, error, warning and dim carry the state, `·` separates facts, and only the glyphs
 * `✓ ✗ ● ○` are used. The status reads the same without color; with `NO_COLOR` set it drops foreground color and
 * keeps the weight.
 */
import { type Container, Spacer, Text } from "@earendil-works/pi-tui";
import { parenthesizedKeyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.js";
import type { ToolRenderResultOptions } from "../extensions/types.ts";
import type { CancelReceipt, WaitOutcome } from "../tasks/contracts.js";
import { getTextOutput, invalidArgText, linkPath, str } from "./render-utils.ts";
import {
	cancelReceiptStatus,
	cleanupFailureSummary,
	EMPTY_OUTPUT_TEXT,
	presentTaskError,
	type TaskStatus,
	waitResultTail,
	waitStatus,
} from "./shell-task-status.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.ts";

/** Output lines shown before a shell result collapses behind the expand hint. */
export const SHELL_OUTPUT_PREVIEW_LINES = 5;

type ResultContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

const noColor = (): boolean => process.env.NO_COLOR !== undefined;

function statusLine(status: TaskStatus): string {
	const head = `${status.glyph} ${status.label}`;
	if (noColor()) return theme.bold(head) + (status.detail ? ` · ${status.detail}` : "");
	const detail = status.detail ? theme.fg("dim", " · ") + theme.fg("muted", status.detail) : "";
	return theme.fg(status.tone, head) + detail;
}

function addErrorLines(component: Container, headline: string, hint: string | undefined): void {
	const heading = `✗ ${headline}`;
	component.addChild(new Text(noColor() ? theme.bold(heading) : theme.fg("error", heading), 0, 0));
	if (hint) component.addChild(new Text(noColor() ? hint : theme.fg("dim", hint), 0, 0));
}

/** The output block of a shell result: everything when expanded, otherwise the last few lines and an expand hint. */
export function addShellOutputPreview(component: Container, output: string, expanded: boolean): void {
	const styledOutput = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	if (expanded) {
		component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		return;
	}
	component.addChild(new Spacer(1));
	component.addChild(
		new VisualLinePreview({
			text: styledOutput,
			maxVisualLines: SHELL_OUTPUT_PREVIEW_LINES,
			keep: "end",
			formatHint: (hidden) =>
				theme.fg("muted", "... ") + parenthesizedKeyHint("app.tools.expand", "Expand", `${hidden} earlier lines`),
		}),
	);
}

export function formatTruncationNotice(truncation: TruncationResult): string {
	return truncation.truncatedBy === "lines"
		? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
		: `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
}

function addTimer(component: Container, timerText: string | undefined): void {
	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

export interface ShellWaitResultView {
	content: ResultContent;
	details?: {
		observation?: WaitOutcome;
		truncation?: TruncationResult;
		fullOutputPath?: string;
	};
}

/**
 * Rebuild the row of a `wait` result: status line, output, a dim note when the output was cut short, then the timer.
 * An error that is not a task failure, or a result without an observation, is left to the generic shell renderer;
 * the return value says whether this renderer handled the result.
 */
export function rebuildShellWaitResult(
	component: Container,
	result: ShellWaitResultView,
	options: Pick<ToolRenderResultOptions, "expanded">,
	view: {
		showImages: boolean;
		isError: boolean;
		taskId: string | undefined;
		timerText: string | undefined;
		cwd: string;
	},
): boolean {
	const text = getTextOutput(result, view.showImages).trim();
	if (view.isError) {
		const error = presentTaskError(text, view.taskId);
		if (!error) return false;
		component.clear();
		addErrorLines(component, error.headline, error.hint);
		addTimer(component, view.timerText);
		return true;
	}
	const observation = result.details?.observation;
	if (!observation) return false;
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const tail = waitResultTail({ observation, truncated: truncation?.truncated === true, fullOutputPath });
	const output = (text.endsWith(tail) ? text.slice(0, -tail.length) : text).trim();
	const hasOutput = output !== "" && output !== EMPTY_OUTPUT_TEXT;
	component.clear();
	component.addChild(new Text(statusLine(waitStatus(observation, hasOutput)), 0, 0));
	if (hasOutput) addShellOutputPreview(component, output, options.expanded);
	else component.addChild(new Text(theme.fg("dim", EMPTY_OUTPUT_TEXT), 0, 0));
	const notes = [
		truncation?.truncated ? formatTruncationNotice(truncation) : undefined,
		fullOutputPath ? "Full output:" : undefined,
	].filter((note) => note !== undefined);
	if (notes.length > 0) component.addChild(new Text(theme.fg("dim", notes.join(" · ")), 0, 0));
	// The path gets a line of its own so word wrap never splits it at a space beside its label, and a link so a
	// path wider than the terminal still opens (and copies) whole.
	if (fullOutputPath) {
		component.addChild(new Text(theme.fg("dim", linkPath(fullOutputPath, fullOutputPath, view.cwd)), 0, 0));
	}
	addTimer(component, view.timerText);
	return true;
}

export function formatKillCall(args: { id?: unknown } | undefined): string {
	const id = str(args?.id);
	const target = id === null ? invalidArgText(theme) : id || theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`kill ${target}`));
}

/** Rebuild the row of a `kill` result from its receipt, or from the failure text when the call was rejected. */
export function rebuildKillResult(
	component: Container,
	result: { content: ResultContent; details?: CancelReceipt },
	view: { isError: boolean; taskId: string | undefined },
): void {
	component.clear();
	const text = getTextOutput(result, false).trim();
	const error = view.isError ? presentTaskError(text, view.taskId) : undefined;
	if (error) {
		addErrorLines(component, error.headline, error.hint);
		return;
	}
	const receipt = result.details;
	// A rejected call carries empty details, so only a real receipt has an execution to describe.
	if (!receipt?.execution) {
		component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
		return;
	}
	component.addChild(new Text(statusLine(cancelReceiptStatus(receipt)), 0, 0));
	const failure = cleanupFailureSummary(receipt.cleanup);
	if (failure)
		component.addChild(
			new Text(statusLine({ glyph: "✗", tone: "error", label: "cleanup failed", detail: failure }), 0, 0),
		);
}
