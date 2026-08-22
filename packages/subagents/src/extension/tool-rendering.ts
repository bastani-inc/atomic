import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { getBurstDisplay } from "../runs/foreground/subagent-executor-burst-display.js";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor-types.js";
import type { Details } from "../shared/types.js";
import { renderLiveSubagentResult } from "../tui/render.js";

type Theme = Parameters<typeof renderLiveSubagentResult>[2];
type RenderContext = Parameters<typeof renderLiveSubagentResult>[3] & { toolCallId: string };

function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
	if (!tasks || tasks.length === 0) return 0;
	return tasks.reduce((total, task) => {
		const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
		return total + count;
	}, 0);
}

export function renderSubagentToolCall(args: SubagentParamsLike, theme: Theme, context: RenderContext): Component {
	const burst = getBurstDisplay(context.toolCallId);
	if (burst && !burst.owner) return new Container();
	if (args.action) {
		const target = args.agent || "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
			0,
			0,
		);
	}
	if (burst) {
		return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${burst.taskCount})`, 0, 0);
	}
	const isParallel = (args.tasks?.length ?? 0) > 0;
	const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
	return new Text(
		isParallel
			? `${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`
			: `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}`,
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
	return renderLiveSubagentResult(burst?.result ?? result, options, theme, context);
}
