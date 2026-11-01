import { keyHintIfBound } from "@bastani/atomic";
import { type Component, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatModelThinking } from "../shared/formatters.js";
import type { SubagentStatusGroup } from "../shared/types.js";
import type { Theme } from "./render-layout.js";

const COMPACT_CHILD_LIMIT = 6;
const statusStyles = {
	pending: { glyph: "○", label: "Pending", color: "dim" },
	running: { glyph: "∀", label: "Running", color: "accent" },
	ok: { glyph: "✓", label: "Completed", color: "success" },
	error: { glyph: "✗", label: "Failed", color: "error" },
	interrupted: { glyph: "■", label: "Interrupted", color: "warning" },
	killed: { glyph: "■", label: "Killed (non-resumable)", color: "warning" },
	continued: { glyph: "■", label: "Continued", color: "warning" },
} as const;

const displayText = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function childStatusLines(
	child: SubagentStatusGroup["children"][number],
	expanded: boolean,
	theme: Theme,
	width: number,
): string[] {
	const style = statusStyles[child.status];
	const name = displayText(child.path.split("/").at(-1) || child.taskName);
	// Truncate before styling: pi-tui's ellipsis reset must not punch a hole in the host card fill.
	const label = expanded
		? name
		: displayText(truncateToWidth(name, Math.max(1, width - visibleWidth(style.label) - 5), "…"));
	const heading = `${theme.fg(style.color, style.glyph)} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("dim", " · ")}${theme.fg(style.color, style.label)}`;
	const model = formatModelThinking(child.model, child.thinking);
	const metadata = model ? [theme.fg("dim", `  ${displayText(model)}`)] : [];
	if (!expanded) return [heading, ...metadata];
	return [
		heading,
		...metadata,
		...(child.childId ? [theme.fg("dim", `  Id: ${displayText(child.childId)}`)] : []),
		theme.fg("dim", `  Path: ${displayText(child.path)}`),
		theme.fg("dim", `  Parent: ${displayText(child.parentPath)} · Depth: ${child.depth}`),
		theme.fg("dim", `  Task: ${displayText(child.taskName)}`),
		theme.fg("dim", `  Residency: ${child.loaded ? "loaded" : "cold"}`),
		...(child.cause ? [theme.fg("muted", `  Cause: ${displayText(child.cause)}`)] : []),
		...(child.failure ? [theme.fg("error", `  Error: ${displayText(child.failure)}`)] : []),
		...(child.sessionFile ? [theme.fg("dim", `  Session: ${displayText(child.sessionFile)}`)] : []),
	];
}

function statusLines(groups: SubagentStatusGroup[], expanded: boolean, theme: Theme, width: number): string[] {
	const total = groups.reduce((sum, group) => sum + group.children.length, 0);
	const lines = total > 1 ? [theme.fg("muted", `${total} agents`)] : [];
	let shown = 0;
	for (const group of groups) {
		const children = expanded ? group.children : group.children.slice(0, COMPACT_CHILD_LIMIT - shown);
		if (!children.length && !expanded) continue;
		if (groups.length > 1 || !children.length) lines.push(theme.fg("dim", `Run ${displayText(group.parentPath)}`));
		lines.push(
			...(children.length
				? children.flatMap((child) => childStatusLines(child, expanded, theme, width))
				: [theme.fg("muted", "  No subagents")]),
		);
		shown += children.length;
	}
	if (!lines.length) lines.push(theme.fg("muted", "No subagents"));
	if (shown < total) lines.push(theme.fg("muted", `… ${total - shown} more agents`));
	const hint = !expanded && keyHintIfBound("app.tools.expand", "to expand");
	if (hint) lines.push(theme.fg("dim", hint));
	return lines;
}

/** Status is a snapshot, not a live progress widget. Never start an animation here. */
export function renderSubagentStatus(groups: SubagentStatusGroup[], expanded: boolean, theme: Theme): Component {
	return {
		invalidate() {},
		render(width) {
			if (width <= 0) return [];
			return new Text(statusLines(groups, expanded, theme, width).join("\n"), 0, 0).render(width);
		},
	};
}
