import type { AgentConfig } from "../../agents/agents.js";
import type { Details, SubagentToolResult } from "../../shared/types.ts";
import type { SubagentParamsLike, TaskParam } from "./subagent-executor-types.ts";

export function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasTasks: boolean,
	hasSingle: boolean,
): SubagentToolResult | null {
	if (Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasSingle) {
		const reads = params.reads;
		if (
			reads !== undefined &&
			reads !== false &&
			(!Array.isArray(reads) || reads.some((entry) => typeof entry !== "string"))
		) {
			return {
				content: [{ type: "text", text: "reads must be an array of file path strings or false" }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	return null;
}

export function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

export function applyAgentDefaultContext(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if (params.context !== undefined) return params;
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	return names.some((name) => byName.get(name)?.defaultContext === "fork") ? { ...params, context: "fork" } : params;
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): SubagentToolResult {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count: _count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) expanded.push({ ...concreteTask });
	}
	return { tasks: expanded };
}

export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): {
	params?: SubagentParamsLike;
	error?: SubagentToolResult;
} {
	if (!params.tasks) return { params };
	const expandedTasks = expandTopLevelTaskCounts(params.tasks);
	if (expandedTasks.error) return { error: buildRequestedModeError(params, expandedTasks.error) };
	return { params: { ...params, tasks: expandedTasks.tasks } };
}

export function withForkContext(
	result: SubagentToolResult,
	context: SubagentParamsLike["context"],
): SubagentToolResult {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

export function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): SubagentToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}
