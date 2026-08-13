import { formatNestedAggregate } from "../runs/inprocess/runtime-support/nested-rendering.ts";
import { formatDuration, formatModelThinking, shortenPath } from "../shared/formatters.ts";
import { MAX_SUBAGENT_NESTING_DEPTH, type NestedRunSummary, type NestedStepSummary } from "../shared/types.ts";
import { runningPulseGlyph, type Theme, truncLine } from "./render-layout.ts";
import { buildLiveStatusLine } from "./render-status-progress.ts";

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string, fastMode?: boolean): string {
	const label = formatModelThinking(model, thinking, fastMode);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

export function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.join(", ");
	return run.id;
}

export function nestedStatusGlyph(
	state: NestedRunSummary["state"] | NestedStepSummary["status"],
	theme: Theme,
	pulseFrame?: number,
): string {
	if (state === "running") return theme.fg("accent", runningPulseGlyph(pulseFrame));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function nestedActivity(
	input: Pick<
		NestedRunSummary | NestedStepSummary,
		| "activityState"
		| "lastActivityAt"
		| "currentTool"
		| "currentToolStartedAt"
		| "currentPath"
		| "turnCount"
		| "toolCount"
	>,
	state: NestedRunSummary["state"] | NestedStepSummary["status"],
	snapshotNow?: number,
): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined)
		facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "failed") return "Failed";
	return "Done";
}

export function formatNestedWidgetLines(
	children: NestedRunSummary[] | undefined,
	theme: Theme,
	width: number,
	expanded: boolean,
	snapshotNow?: number,
	lineBudget = expanded ? 12 : 1,
	now?: number,
): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
	}
	const lines: string[] = [];
	const maxDepth = MAX_SUBAGENT_NESTING_DEPTH;
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= lineBudget) return;
		if (depth > maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
			const error = child.error ? ` · ${child.error}` : "";
			lines.push(
				theme.fg(
					"dim",
					`${prefix}↳ ${nestedStatusGlyph(child.state, theme, now)} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`,
				),
			);
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([
					...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
					...(child.children ?? []),
				]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				lines.push(
					theme.fg(
						"dim",
						`${prefix}  ↳ ${nestedStatusGlyph(step.status, theme, now)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`,
					),
				);
				append(step.children, depth + 1, `${prefix}    `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, "");
	return lines.map((line) => truncLine(line, width));
}
