import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@bastani/atomic";
import type { SingleResult, SubagentToolResult } from "../../shared/types.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import { formatParallelResultContent } from "../shared/parallel-utils.js";
import { formatParentAskPauseOutput } from "./parent-ask-output.js";
import { registerBurstDisplay, updateBurstDisplay } from "./subagent-executor-burst-display.js";
import { getLiveResultIndices } from "./subagent-executor-live-update.js";
import { getParentAskPause } from "./subagent-executor-parent-ask-projection.js";
import { resolveRequestedCwd } from "./subagent-executor-resume.js";
import {
	BURST_TASK_DISCOVERY_CWD,
	type BurstTaskParam,
	type SubagentParamsLike,
	type TaskParam,
} from "./subagent-executor-types.js";

interface BurstItem {
	id: string;
	params: SubagentParamsLike;
	signal: AbortSignal;
	onUpdate?: (result: SubagentToolResult) => void;
	ctx: ExtensionContext;
	settled: boolean;
	resolve: (result: SubagentToolResult) => void;
	reject: (reason?: unknown) => void;
}

interface ResultRoute {
	start: number;
	length: number;
}

type ExecuteSubagent = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: SubagentToolResult) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<SubagentToolResult>;

type SharedField =
	| "concurrency"
	| "worktree"
	| "context"
	| "share"
	| "control"
	| "sessionDir"
	| "maxOutput"
	| "artifacts"
	| "includeProgress"
	| "agentScope";

const SHARED_FIELDS: readonly SharedField[] = [
	"concurrency",
	"worktree",
	"context",
	"share",
	"control",
	"sessionDir",
	"maxOutput",
	"artifacts",
	"includeProgress",
	"agentScope",
];

function incompatibleField(items: BurstItem[]): SharedField | undefined {
	const first = items[0]!.params;
	for (const field of SHARED_FIELDS) {
		for (let index = 1; index < items.length; index++) {
			if (!isDeepStrictEqual(first[field], items[index]!.params[field])) return field;
		}
	}
	return undefined;
}

function incompatibleFieldResult(field: SharedField): SubagentToolResult {
	return {
		content: [
			{
				type: "text",
				text: `Cannot coalesce sibling subagent calls: incompatible top-level field '${field}'.`,
			},
		],
		isError: true,
		details: { mode: "parallel", results: [] },
	};
}

function incompatibleWorktreeCwdResult(): SubagentToolResult {
	return {
		content: [
			{
				type: "text",
				text: "Cannot coalesce sibling subagent calls: incompatible top-level field 'cwd' for worktree.",
			},
		],
		isError: true,
		details: { mode: "parallel", results: [] },
	};
}

function taskExpandedLength(task: TaskParam): number {
	const count = task.count;
	return typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : 1;
}

function originatingCallCwd(item: BurstItem): string {
	return resolveRequestedCwd(item.ctx.cwd, item.params.cwd);
}

function originatingTaskCwd(callCwd: string, taskCwd: string | undefined): string {
	return resolveRequestedCwd(callCwd, taskCwd);
}

function topLevelSingleTask(item: BurstItem): BurstTaskParam | undefined {
	if (!item.params.agent) return undefined;
	const callCwd = originatingCallCwd(item);
	return {
		agent: item.params.agent,
		task: item.params.task ?? "",
		cwd: originatingTaskCwd(callCwd, undefined),
		[BURST_TASK_DISCOVERY_CWD]: callCwd,
		...(item.params.output !== undefined ? { output: item.params.output } : {}),
		...(item.params.outputMode !== undefined ? { outputMode: item.params.outputMode } : {}),
		...(item.params.reads !== undefined ? { reads: item.params.reads } : {}),
		...(item.params.progress !== undefined ? { progress: item.params.progress } : {}),
		...(item.params.model !== undefined ? { model: item.params.model } : {}),
		...(item.params.skill !== undefined ? { skill: item.params.skill } : {}),
		...(item.params.group !== undefined ? { group: item.params.group } : {}),
	};
}

function existingParallelTask(item: BurstItem, task: TaskParam): BurstTaskParam {
	const callCwd = originatingCallCwd(item);
	return {
		...task,
		cwd: originatingTaskCwd(callCwd, task.cwd),
		[BURST_TASK_DISCOVERY_CWD]: callCwd,
		...(task.group === undefined && item.params.group !== undefined ? { group: item.params.group } : {}),
	};
}

function mergeBurst(items: BurstItem[]): {
	params?: SubagentParamsLike;
	routes?: ResultRoute[];
	error?: SubagentToolResult;
} {
	const field = incompatibleField(items);
	if (field) return { error: incompatibleFieldResult(field) };
	const callCwds = items.map(originatingCallCwd);
	const commonCwd = callCwds.every((cwd) => cwd === callCwds[0]) ? callCwds[0] : undefined;
	if (items[0]!.params.worktree === true && commonCwd === undefined) return { error: incompatibleWorktreeCwdResult() };

	const tasks: TaskParam[] = [];
	const routes: ResultRoute[] = [];
	for (const item of items) {
		const start = tasks.reduce((total, task) => total + taskExpandedLength(task), 0);
		const single = topLevelSingleTask(item);
		if (single) tasks.push(single);
		for (const task of item.params.tasks ?? []) tasks.push(existingParallelTask(item, task));
		const end = tasks.reduce((total, task) => total + taskExpandedLength(task), 0);
		routes.push({ start, length: end - start });
	}

	const first = items[0]!.params;
	return {
		params: {
			...(commonCwd ? { cwd: commonCwd } : {}),
			tasks,
			concurrency: first.concurrency,
			worktree: first.worktree,
			context: first.context,
			share: first.share,
			control: first.control,
			sessionDir: first.sessionDir,
			maxOutput: first.maxOutput,
			artifacts: first.artifacts,
			includeProgress: first.includeProgress,
			agentScope: first.agentScope,
		},
		routes,
	};
}
function formatStandardParallelContent(results: SingleResult[]): string {
	return formatParallelResultContent(
		results.map((child) => ({
			agent: child.agent,
			output: child.truncation?.text || getSingleResultOutput(child),
			status: child.status,
			error: child.error,
		})),
		(index, agent) => `=== Task ${index + 1}: ${agent} ===`,
	);
}

function projectParentAskContent(
	result: SubagentToolResult,
	route: ResultRoute,
	projectedResults: SingleResult[],
): SubagentToolResult["content"] | undefined {
	const pause = getParentAskPause(result);
	if (!pause) return undefined;
	const originalItem =
		result.content.length === 1 && result.content[0]?.type === "text"
			? result.content[0]
			: { type: "text" as const, text: "" };
	const routeEnd = route.start + route.length;
	const inRoute = (index: number): boolean => index >= route.start && index < routeEnd;
	if (!inRoute(pause.askingChildIndex)) {
		return [{ ...originalItem, text: formatStandardParallelContent(projectedResults) }];
	}
	const projectIndex = (index: number): number => index - route.start;
	return [
		{
			...originalItem,
			text: formatParentAskPauseOutput({
				...pause,
				askingChildIndex: projectIndex(pause.askingChildIndex),
				releasedChildIndices: pause.releasedChildIndices.filter(inRoute).map(projectIndex),
				unlaunchedChildIndices: pause.unlaunchedChildIndices.filter(inRoute).map(projectIndex),
				request: { ...pause.request, index: projectIndex(pause.request.index) },
			}),
		},
	];
}

function projectParallelContent(
	result: SubagentToolResult,
	sharedResults: SingleResult[],
	projectedResults: SingleResult[],
	route: ResultRoute,
	live: boolean,
): SubagentToolResult["content"] {
	const projectedText = formatStandardParallelContent(projectedResults);
	if (live) return [{ type: "text", text: projectedText }];
	const parentAskContent = projectParentAskContent(result, route, projectedResults);
	if (parentAskContent) return parentAskContent;
	if (result.content.length !== 1 || result.content[0]?.type !== "text") return result.content;
	const originalItem = result.content[0];
	const originalText = originalItem.text;
	const sharedText = formatStandardParallelContent(sharedResults);
	if (originalText === sharedText) return [{ ...originalItem, text: projectedText }];
	if (originalText.startsWith(`${sharedText}\n\n`)) {
		return [{ ...originalItem, text: `${projectedText}${originalText.slice(sharedText.length)}` }];
	}
	return result.content;
}

function projectResult(result: SubagentToolResult, route: ResultRoute, live = false): SubagentToolResult {
	const sharedDetails = result.details;
	if (!sharedDetails || (!live && sharedDetails.results.length === 0)) return result;

	const liveIndices = live ? getLiveResultIndices(result) : undefined;
	const results = liveIndices
		? sharedDetails.results.filter((_child, index) => {
				const resultIndex = liveIndices[index];
				return resultIndex !== undefined && resultIndex >= route.start && resultIndex < route.start + route.length;
			})
		: sharedDetails.results.slice(route.start, route.start + route.length);
	const progress = sharedDetails.progress
		?.filter((item) => item.index >= route.start && item.index < route.start + route.length)
		.map((item) => ({ ...item, index: item.index - route.start }));
	const controlEvents = sharedDetails.controlEvents
		?.filter(
			(event) => event.index !== undefined && event.index >= route.start && event.index < route.start + route.length,
		)
		.map((event) => ({ ...event, index: event.index! - route.start }));
	const artifactFiles = results.flatMap((child) => (child.artifactPaths ? [child.artifactPaths] : []));

	return {
		content: projectParallelContent(result, sharedDetails.results, results, route, live),
		...(result.isError !== undefined ? { isError: result.isError } : {}),
		details: {
			mode: "parallel",
			...(sharedDetails.runId !== undefined ? { runId: sharedDetails.runId } : {}),
			...(sharedDetails.context !== undefined ? { context: sharedDetails.context } : {}),
			results,
			...(progress?.length ? { progress } : {}),
			...(controlEvents?.length ? { controlEvents } : {}),
			...(sharedDetails.totalSteps !== undefined ? { totalSteps: route.length } : {}),
			...(sharedDetails.parentAskPaused !== undefined ? { parentAskPaused: sharedDetails.parentAskPaused } : {}),
			...(sharedDetails.artifacts && artifactFiles.length
				? { artifacts: { dir: sharedDetails.artifacts.dir, files: artifactFiles } }
				: {}),
		},
	};
}

function resolveItem(item: BurstItem, result: SubagentToolResult): void {
	if (item.settled) return;
	item.settled = true;
	item.resolve(result);
}

function rejectItem(item: BurstItem, reason: unknown): void {
	if (item.settled) return;
	item.settled = true;
	item.reject(reason);
}

function observeLaterAbort(item: BurstItem): () => void {
	let listening = false;
	const cleanup = (): void => {
		if (!listening) return;
		listening = false;
		item.signal.removeEventListener("abort", onAbort);
	};
	const onAbort = (): void => {
		cleanup();
		const reason = item.signal.reason;
		rejectItem(item, reason === undefined ? new DOMException("The operation was aborted", "AbortError") : reason);
	};
	if (item.signal.aborted) {
		onAbort();
	} else {
		listening = true;
		item.signal.addEventListener("abort", onAbort, { once: true });
		if (item.signal.aborted) onAbort();
	}
	return cleanup;
}

export function createExecutionBurstDispatcher(input: {
	execute: ExecuteSubagent;
	isActive: () => boolean;
	setActive: (active: boolean) => void;
	duplicateResult: (params: SubagentParamsLike) => SubagentToolResult;
}): ExecuteSubagent {
	let queue: BurstItem[] = [];
	let flushScheduled = false;

	const run = async (items: BurstItem[]): Promise<void> => {
		if (items.length === 1) {
			const item = items[0]!;
			input.setActive(true);
			try {
				item.resolve(await input.execute(item.id, item.params, item.signal, item.onUpdate, item.ctx));
			} catch (error) {
				item.reject(error instanceof Error ? error : new Error(String(error)));
			} finally {
				input.setActive(false);
			}
			return;
		}

		const abortCleanups = items.slice(1).map(observeLaterAbort);
		const cleanupLaterAborts = (): void => {
			for (const cleanup of abortCleanups) cleanup();
		};
		const merged = mergeBurst(items);
		if (merged.error) {
			for (const item of items) resolveItem(item, merged.error);
			cleanupLaterAborts();
			return;
		}

		const first = items[0]!;
		const display = registerBurstDisplay(
			items.map((item) => item.id),
			merged.routes!.reduce((total, route) => total + route.length, 0),
		);
		const onUpdate = (update: SubagentToolResult): void => {
			updateBurstDisplay(display, update);
			for (let index = 0; index < items.length; index++) {
				const item = items[index]!;
				if (!item.settled) item.onUpdate?.(projectResult(update, merged.routes![index]!, true));
			}
		};
		input.setActive(true);
		try {
			const result = await input.execute(first.id, merged.params!, first.signal, onUpdate, first.ctx);
			updateBurstDisplay(display, result);
			for (let index = 0; index < items.length; index++) {
				resolveItem(items[index]!, projectResult(result, merged.routes![index]!));
			}
		} catch (error) {
			const rejection = error instanceof Error ? error : new Error(String(error));
			for (const item of items) rejectItem(item, rejection);
		} finally {
			input.setActive(false);
			cleanupLaterAborts();
		}
	};

	const flush = (): void => {
		flushScheduled = false;
		const items = queue;
		queue = [];
		void run(items);
	};

	return (id, params, signal, onUpdate, ctx) => {
		if (input.isActive()) return Promise.resolve(input.duplicateResult(params));
		return new Promise<SubagentToolResult>((resolve, reject) => {
			queue.push({ id, params, signal, onUpdate, ctx, settled: false, resolve, reject });
			if (!flushScheduled) {
				flushScheduled = true;
				setImmediate(flush);
			}
		});
	};
}
