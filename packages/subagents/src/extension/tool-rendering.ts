import { keyHintIfBound } from "@bastani/atomic";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type SubagentChildIndexEntry,
	subagentChildCardRecord,
	subagentChildTranscript,
	watchSubagentChildCard,
} from "../runs/foreground/subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
} from "../runs/foreground/subagent-child-records.js";
import { getBurstDisplay } from "../runs/foreground/subagent-executor-burst-display.js";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor-types.js";
import { subagentTaskResultLabel } from "../runs/foreground/task-execution.js";
import { formatModelThinking } from "../shared/formatters.js";
import type { Details } from "../shared/types.js";
import { renderLiveSubagentResult } from "../tui/render.js";

type Theme = Parameters<typeof renderLiveSubagentResult>[2];
type RenderContext = Parameters<typeof renderLiveSubagentResult>[3] & {
	toolCallId: string;
	invalidate: () => void;
	isError?: boolean;
};
type ThemeColor = Parameters<Theme["fg"]>[0];

const renderRequests = new WeakMap<object, SubagentParamsLike>();
/** The settled per-child counts a parallel result reported, shown on its call header (#4697). */
const parallelSummaries = new WeakMap<object, string>();

/** Outcome categories, in the order the header lists them. */
const OUTCOME_CATEGORIES = [
	{ key: "running", color: "accent" },
	{ key: "done", color: "success" },
	{ key: "failed", color: "error" },
	{ key: "stopped", color: "warning" },
	{ key: "skipped", color: "dim" },
] as const satisfies ReadonlyArray<{ key: string; color: ThemeColor }>;
type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number]["key"];

function outcomeCategory(color: ThemeColor): OutcomeCategory {
	if (color === "accent") return "running";
	if (color === "success") return "done";
	if (color === "error") return "failed";
	return "stopped";
}

function parallelSummary(categories: readonly OutcomeCategory[], theme: Theme): string {
	return OUTCOME_CATEGORIES.flatMap(({ key, color }) => {
		const count = categories.filter((category) => category === key).length;
		return count ? [`${theme.fg("dim", " · ")}${theme.fg(color, `${count} ${key}`)}`] : [];
	}).join("");
}

/** One line cut to the width it is drawn at, ending in `…` when cut. */
class OneLine implements Component {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [truncateToWidth(this.text, width, "…")];
	}
}

/** A parallel call header that reads its result's counts when drawn, after the result renderer recorded them. */
class ParallelCallHeader implements Component {
	constructor(
		private readonly heading: string,
		private readonly state: object,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		return new Text(`${this.heading}${parallelSummaries.get(this.state) ?? ""}`, 0, 0).render(width);
	}
}
const displayText = (text: string) =>
	text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
	if (!tasks || tasks.length === 0) return 0;
	return tasks.reduce((total, task) => {
		const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
		return total + count;
	}, 0);
}

const SETTLED_VIEWS: Readonly<Record<string, { icon: string; label: string; color: ThemeColor }>> = {
	ok: { icon: "✓", label: "Completed", color: "success" },
	error: { icon: "✗", label: "Failed", color: "error" },
	paused: { icon: "‖", label: "Paused · awaiting resume", color: "warning" },
	quit: { icon: "‖", label: "Quit · paused · awaiting resume", color: "warning" },
	interrupted: { icon: "○", label: "Interrupted (resumable)", color: "warning" },
	[SUBAGENT_CHILD_STAGE_PAUSED_STATUS]: {
		icon: "‖",
		label: "Paused with its workflow stage · awaiting resume",
		color: "warning",
	},
	killed: { icon: "✗", label: "Terminal · killed", color: "error" },
	[SUBAGENT_CHILD_GONE_STATUS]: { icon: "✗", label: "Terminal · gone after a restart", color: "error" },
	[SUBAGENT_CHILD_STAGE_CLOSED_STATUS]: { icon: "✗", label: "Terminal · its workflow stage ended", color: "error" },
};

/** What a launch card shows for its child's latest record, rather than the snapshot taken at launch. */
function childStateView(record: SubagentChildIndexEntry): { icon: string; label: string; color: ThemeColor } {
	if (record.state === "running") return { icon: "∀", label: "Running in background", color: "accent" };
	return (
		SETTLED_VIEWS[record.terminalStatus ?? ""] ?? {
			icon: "○",
			label: `Stopped (${record.terminalStatus ?? "settled"})`,
			color: "warning",
		}
	);
}

export function renderSubagentToolCall(args: SubagentParamsLike, theme: Theme, context: RenderContext): Component {
	renderRequests.set(context.state, args);
	const burst = getBurstDisplay(context.toolCallId);
	if (burst && !burst.owner) return new Container();
	if (args.action) {
		const target = args.agent || args.id || args.runId || (args.all ? "all" : "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg(args.action === "status" ? "dim" : "accent", displayText(target))}` : ""}`,
			0,
			0,
		);
	}
	if (burst) {
		return new ParallelCallHeader(
			`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${burst.taskCount})`,
			context.state,
		);
	}
	if ((args.tasks?.length ?? 0) > 0) {
		const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
		return new ParallelCallHeader(
			`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
			context.state,
		);
	}
	// Truncation adds full ANSI resets even to plain text; remove them before styling so the host background survives.
	return new Text(
		`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", displayText(args.agent || "?"))}${args.task ? `\n${theme.fg("muted", displayText(truncateToWidth(displayText(args.task), 100)))}` : ""}`,
		0,
		0,
	);
}

export function renderSubagentToolResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const burst = getBurstDisplay(context.toolCallId);
	if (burst && !burst.owner) return new Container();
	result = burst?.result ?? result;
	if (result.details?.taskError)
		return new Text(theme.fg("error", `✗ ${displayText(result.details.taskError)}`), 0, 0);
	const runControl = result.details?.runControl;
	if (runControl) {
		const text = result.content.find((part) => part.type === "text");
		const failed = context.isError === true || (result as { isError?: boolean }).isError === true;
		if (failed || runControl.children.length === 0)
			return new Text(
				theme.fg(
					failed ? "error" : "dim",
					`${failed ? "✗ " : ""}${displayText(text?.type === "text" ? text.text : "")}`,
				),
				0,
				0,
			);
		const lines = runControl.children.map((child) => {
			const state =
				child.state === "running"
					? theme.fg("success", `▶ Resumed · ${displayText(child.agent)}`)
					: theme.fg(
							"warning",
							`${child.state === "paused" ? "‖ Paused" : "■ Quit (resumable)"} · ${displayText(child.agent)}`,
						);
			const identity = theme.fg(
				"dim",
				`\n   ${displayText(child.childId)}${child.intercomTarget ? ` · ${displayText(child.intercomTarget)}` : ""}${options.expanded && child.taskId ? ` · ${displayText(child.taskId)}` : ""}`,
			);
			return `${state}${identity}${child.state === "running" ? theme.fg("dim", "\n   continues in its original launch card") : ""}`;
		});
		if (runControl.message && options.expanded) lines.push(theme.fg("muted", displayText(runControl.message)));
		return new Text(lines.join("\n"), 0, 0);
	}
	if (result.details?.taskRecords && !result.details.taskResponse) {
		const lines = result.details.taskRecords.flatMap((task) => {
			const state =
				task.execution.kind === "settled" ? subagentTaskResultLabel(task.execution.result) : task.execution.kind;
			return [
				theme.bold(`${displayText(task.agentName ?? "bash")} · ${state}`),
				...(task.kind === "agent"
					? [
							theme.fg(
								"dim",
								displayText(formatModelThinking(task.model, task.thinking) || "model / thinking unavailable"),
							),
						]
					: []),
				theme.fg("muted", displayText(task.title)),
				...(options.expanded ? [theme.fg("dim", task.ref.taskId)] : []),
				...(task.execution.kind === "settled" && task.execution.result.kind === "failed"
					? [theme.fg("error", displayText(task.execution.result.message))]
					: []),
			];
		});
		return new Text([...lines, theme.fg("dim", "/tasks to inspect output and manage tasks")].join("\n"), 0, 0);
	}
	const response = result.details?.taskResponse;
	const request = renderRequests.get(context.state);
	if (response) {
		const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
		const labels =
			request && !burst
				? [
						...(request.agent ? [{ agent: request.agent, task: request.task ?? "" }] : []),
						...(request.tasks ?? []).flatMap((task) =>
							Array.from({ length: Math.max(1, task.count ?? 1) }, () => task),
						),
					]
				: [];
		const rows = outcomes.map((outcome, index): { line: string; error?: string; category: OutcomeCategory } => {
			const identity = labels[index];
			const name = outcomes.length > 1 ? `${index + 1}. ${identity ? displayText(identity.agent) : "Agent"} · ` : "";
			if (outcome.kind === "unstarted")
				// #4697: a child that failed to start keeps its own row; its siblings report theirs.
				return outcome.reason.kind === "rejected"
					? {
							line: theme.fg("error", `✗ ${name}Not started`),
							error: outcome.reason.error.message,
							category: "failed",
						}
					: { line: theme.fg("dim", `○ ${name}Skipped`), category: "skipped" };
			const failure =
				outcome.observation.kind === "settled" && outcome.observation.result.kind === "failed"
					? outcome.observation.result.message
					: undefined;
			const observation = outcome.observation;
			const task = result.details?.taskRecords?.find((task) => task.ref.taskId === observation.taskId);
			const childId = task?.launchOperationId;
			const record = subagentChildCardRecord(childId, observation.taskId);
			watchSubagentChildCard(
				context.state,
				context.invalidate,
				record?.childId ?? childId ?? observation.taskId,
				result.details?.ownerSessionId,
			);
			if (record) {
				const view = childStateView(record);
				const resumed = record.taskId !== undefined && record.taskId !== observation.taskId ? " · resumed" : "";
				const transcript = options.expanded ? subagentChildTranscript(context.state, record) : undefined;
				const line = [
					theme.fg(view.color, `${view.icon} ${name}${view.label}${resumed}`),
					theme.fg(
						"dim",
						`\n   ${displayText(formatModelThinking(task?.model, task?.thinking) || "model / thinking unavailable")}`,
					),
					options.expanded
						? theme.fg(
								"dim",
								`\n   ${record.taskId ?? observation.taskId}${identity?.task ? ` · ${displayText(identity.task)}` : ""}`,
							)
						: "",
					transcript?.length
						? transcript.map((line) => `\n   ${theme.fg("muted", `│ ${displayText(line)}`)}`).join("")
						: "",
				].join("");
				return {
					line,
					...(view.color === "error" && failure ? { error: failure } : {}),
					category: outcomeCategory(view.color),
				};
			}
			const state =
				observation.kind === "yielded"
					? request?.action === "wait"
						? "Still running in background"
						: "Launched in background"
					: observation.result.kind === "completed"
						? "Completed"
						: observation.result.kind === "failed"
							? "Failed"
							: subagentTaskResultLabel(observation.result) === "killed (non-resumable)"
								? "Killed (non-resumable)"
								: subagentTaskResultLabel(observation.result) === "paused · awaiting resume"
									? "Paused · awaiting resume"
									: "Stopped";
			const icon =
				observation.kind === "yielded"
					? "∀"
					: observation.result.kind === "completed"
						? "✓"
						: observation.result.kind === "failed"
							? "✗"
							: "○";
			const color =
				observation.kind === "yielded"
					? "accent"
					: observation.result.kind === "failed"
						? "error"
						: observation.result.kind === "completed"
							? "success"
							: "warning";
			const summary = theme.fg(color, `${icon} ${name}${state}`);
			const model = theme.fg(
				"dim",
				`\n   ${displayText(formatModelThinking(task?.model, task?.thinking) || "model / thinking unavailable")}`,
			);
			const metadata = options.expanded
				? theme.fg("dim", `\n   ${observation.taskId}${identity?.task ? ` · ${displayText(identity.task)}` : ""}`)
				: "";
			return {
				line: summary + model + metadata,
				...(failure ? { error: failure } : {}),
				category: outcomeCategory(color),
			};
		});
		if (outcomes.length > 1)
			parallelSummaries.set(
				context.state,
				parallelSummary(
					rows.map((row) => row.category),
					theme,
				),
			);
		const view = new Container();
		for (const [index, row] of rows.entries()) {
			const branch = outcomes.length > 1 ? `${index === rows.length - 1 ? "└─" : "├─"} ` : "";
			view.addChild(new Text(`${branch}${row.line}`, 0, 0));
			if (row.error === undefined) continue;
			// Collapsed, an error is one truncated line; expanded shows all of it.
			const error = `   ${theme.fg("error", displayText(row.error))}`;
			view.addChild(options.expanded ? new Text(error, 0, 0) : new OneLine(error));
		}
		view.addChild(new Text(theme.fg("dim", "/tasks to inspect output and manage tasks"), 0, 0));
		return view;
	}
	const text = result.content.find((part) => part.type === "text");
	if (text?.type === "text" && text.text.startsWith("Executable agents:")) {
		const count = text.text.split("\n").filter((line) => line.startsWith("- ") && line !== "- (none)").length;
		return new Text(
			options.expanded
				? text.text
				: `${theme.bold(`${count} available agents`)}\n${theme.fg(
						"dim",
						["/agents to browse", keyHintIfBound("app.tools.expand", "Expand")]
							.filter(Boolean)
							.map((hint, index) => (index ? `(${hint})` : hint))
							.join(" · "),
					)}`,
			0,
			0,
		);
	}
	if (
		context.isError &&
		text?.type === "text" &&
		!result.details?.results?.length &&
		!result.details?.progress?.length
	)
		return new Text(theme.fg("error", `✗ ${displayText(text.text)}`), 0, 0);
	return renderLiveSubagentResult(burst?.result ?? result, options, theme, context);
}
