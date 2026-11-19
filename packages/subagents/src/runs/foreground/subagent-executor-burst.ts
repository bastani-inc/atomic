import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@bastani/atomic";
import type {
	ModelAdmitted,
	ModelSingleResponse,
	ModelUnstarted,
} from "../../../../coding-agent/src/core/tasks/contracts.js";
import type { SingleResult, SubagentToolResult } from "../../shared/types.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import { formatParallelResultContent } from "../shared/parallel-utils.js";
import { formatParentAskHandoffOutput } from "./parent-ask-output.js";
import { registerBurstDisplay, releaseBurstDisplay, updateBurstDisplay } from "./subagent-executor-burst-display.js";
import { resolveRequestedCwd } from "./subagent-executor-cwd.js";
import { withForkContext } from "./subagent-executor-input.js";
import { getParentAskHandoff } from "./subagent-executor-parent-ask-projection.js";
import {
	BURST_PREPARED_TASKS,
	BURST_TASK_DISCOVERY_CWD,
	BURST_TASK_INPUT_INDEX,
	type BurstTaskParam,
	type SubagentParamsLike,
	type TaskParam,
} from "./subagent-executor-types.js";
import { parallelTaskToolResultWithOutput, taskToolResultWithOutput } from "./task-execution.js";

interface BurstItem {
	id: string;
	params: SubagentParamsLike;
	signal: AbortSignal;
	onUpdate?: (result: SubagentToolResult) => void;
	ctx: ExtensionContext;
	settled: boolean;
	resolve: (result: SubagentToolResult) => void;
	reject: (reason?: unknown) => void;
	/** The `wait` the call passed, undefined when it passed none; see {@link byLegacyWait}. */
	legacyWait?: unknown;
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

/** A launch into the burst, with the `wait` the call passed (undefined when none): see {@link byLegacyWait}. */
export type ExecuteBurstLaunch = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: SubagentToolResult) => void) | undefined,
	ctx: ExtensionContext,
	legacyWait?: unknown,
) => Promise<SubagentToolResult>;

/**
 * The burst's calls by the `wait` each passed, in order of first appearance; calls that pass none form one group.
 * Before every launch ran in the background, calls with different waits launched as separate runs (#5686).
 */
function byLegacyWait(items: BurstItem[]): BurstItem[][] {
	const groups: BurstItem[][] = [];
	for (const item of items) {
		const group = groups.find((candidate) => isDeepStrictEqual(candidate[0]!.legacyWait, item.legacyWait));
		if (group) group.push(item);
		else groups.push([item]);
	}
	return groups;
}

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

/** Shared fields that are off unless set to `true`: `false` and leaving them out ask for the same. */
const OFF_UNLESS_TRUE: ReadonlySet<SharedField> = new Set(["worktree", "share", "includeProgress"]);

/**
 * The value a call gives a field its burst shares. A named worktree belongs to its call's own children (#5202); only
 * `worktree: true` is shared by the burst.
 */
function sharedValue(params: SubagentParamsLike, field: SharedField): SubagentParamsLike[SharedField] {
	return OFF_UNLESS_TRUE.has(field) ? (params[field] === true ? true : undefined) : params[field];
}

/** The named worktree a call's top level gives each of its children without one of their own. */
function namedWorktree(params: SubagentParamsLike): TaskParam["worktree"] {
	return typeof params.worktree === "object" ? params.worktree : undefined;
}

function incompatibleField(items: BurstItem[]): SharedField | undefined {
	const first = items[0]!.params;
	for (const field of SHARED_FIELDS) {
		for (let index = 1; index < items.length; index++) {
			if (!isDeepStrictEqual(sharedValue(first, field), sharedValue(items[index]!.params, field))) return field;
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
		...(namedWorktree(item.params) ? { worktree: namedWorktree(item.params) } : {}),
		...(item.params.output !== undefined ? { output: item.params.output } : {}),
		...(item.params.outputMode !== undefined ? { outputMode: item.params.outputMode } : {}),
		...(item.params.reads !== undefined ? { reads: item.params.reads } : {}),
		...(item.params.progress !== undefined ? { progress: item.params.progress } : {}),
		...(item.params.model !== undefined ? { model: item.params.model } : {}),
		...(item.params.skill !== undefined ? { skill: item.params.skill } : {}),
		...(item.params.group !== undefined ? { group: item.params.group } : {}),
		...(item.params.heartbeatMs !== undefined ? { heartbeatMs: item.params.heartbeatMs } : {}),
	};
}

function existingParallelTask(item: BurstItem, task: TaskParam): BurstTaskParam {
	const callCwd = originatingCallCwd(item);
	return {
		...task,
		cwd: originatingTaskCwd(callCwd, task.cwd),
		[BURST_TASK_DISCOVERY_CWD]: callCwd,
		...(task.worktree === undefined && namedWorktree(item.params) ? { worktree: namedWorktree(item.params) } : {}),
		...(task.group === undefined && item.params.group !== undefined ? { group: item.params.group } : {}),
		...(task.heartbeatMs === undefined && item.params.heartbeatMs !== undefined
			? { heartbeatMs: item.params.heartbeatMs }
			: {}),
	};
}

/** A mixed call in a burst contributes its top-level child first. Keep that same task list for checks and retries. */
function collectMixedCall(item: BurstItem): BurstItem {
	if (!item.params.agent || !item.params.tasks?.length) return item;
	const tasks = [
		topLevelSingleTask(item)!,
		...item.params.tasks.map((task, index) => ({
			...existingParallelTask(item, task),
			[BURST_TASK_INPUT_INDEX]: index,
		})),
	];
	return { ...item, params: { ...item.params, agent: undefined, task: undefined, tasks } };
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
		for (const task of item.params.tasks ?? []) {
			tasks.push(existingParallelTask(item, task));
		}
		const end = tasks.reduce((total, task) => total + taskExpandedLength(task), 0);
		routes.push({ start, length: end - start });
	}

	const first = items[0]!.params;
	return {
		params: {
			...(commonCwd ? { cwd: commonCwd } : {}),
			tasks,
			concurrency: first.concurrency,
			worktree: first.worktree === true ? true : undefined,
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
	const handoff = getParentAskHandoff(result);
	if (!handoff) return undefined;
	const originalItem =
		result.content.length === 1 && result.content[0]?.type === "text"
			? result.content[0]
			: { type: "text" as const, text: "" };
	const routeEnd = route.start + route.length;
	const inRoute = (index: number): boolean => index >= route.start && index < routeEnd;
	if (!inRoute(handoff.askingChildIndex)) {
		return [{ ...originalItem, text: formatStandardParallelContent(projectedResults) }];
	}
	const projectIndex = (index: number): number => index - route.start;
	return [
		{
			...originalItem,
			text: formatParentAskHandoffOutput({
				...handoff,
				askingChildIndex: projectIndex(handoff.askingChildIndex),
				releasedChildIndices: handoff.releasedChildIndices.filter(inRoute).map(projectIndex),
				unlaunchedChildIndices: handoff.unlaunchedChildIndices.filter(inRoute).map(projectIndex),
				request: { ...handoff.request, index: projectIndex(handoff.request.index) },
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

	const liveIndices = live ? sharedDetails.resultIndices : undefined;
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
			...(liveIndices
				? {
						resultIndices: liveIndices
							.filter((i) => i >= route.start && i < route.start + route.length)
							.map((i) => i - route.start),
					}
				: {}),
			...(progress?.length ? { progress } : {}),
			...(controlEvents?.length ? { controlEvents } : {}),
			...(sharedDetails.totalSteps !== undefined ? { totalSteps: route.length } : {}),
			...(sharedDetails.parentAskYielded !== undefined ? { parentAskYielded: sharedDetails.parentAskYielded } : {}),
			...(sharedDetails.artifacts && artifactFiles.length
				? { artifacts: { dir: sharedDetails.artifacts.dir, files: artifactFiles } }
				: {}),
		},
	};
}

function isSingleResponse(outcome: ModelAdmitted | ModelUnstarted): outcome is ModelSingleResponse {
	return outcome.kind === "admitted" || outcome.reason.kind === "rejected";
}

async function projectOwnerResult(
	result: SubagentToolResult,
	route: ResultRoute,
	item: BurstItem,
	ctx: ExtensionContext,
): Promise<SubagentToolResult | undefined> {
	const response = result.details?.taskResponse;
	if (response?.kind !== "parallel") return undefined;
	const slots = response.slots
		.slice(route.start, route.start + route.length)
		.map((slot, ordinal) => ({ ...slot, ordinal }));
	const host = ctx.getAgentTaskHost?.();
	const own = slots.length === 1 ? slots[0]!.outcome : undefined;
	const projected =
		item.params.agent !== undefined && own !== undefined && isSingleResponse(own)
			? await taskToolResultWithOutput(own, host)
			: await parallelTaskToolResultWithOutput({ kind: "parallel", slots }, host);
	return withForkContext(projected, item.params.context ?? result.details?.context);
}

/** A run that failed before any of its children started, as an unknown agent or invalid input fails it. */
function failedBeforeStart(result: SubagentToolResult): boolean {
	return (
		result.isError === true &&
		result.details?.taskResponse === undefined &&
		(result.details?.results.length ?? 0) === 0
	);
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
	/** The error a launch fails with on its own before any child starts, from the checks its own run makes. */
	ownError: (
		params: SubagentParamsLike,
		ctx: ExtensionContext,
		preparedTasks?: TaskParam[],
	) => Promise<SubagentToolResult | undefined>;
}): ExecuteBurstLaunch {
	let queue: BurstItem[] = [];
	let flushScheduled = false;

	/**
	 * Gives each launch that fails on its own its own error, and returns the others. A failure to check leaves the
	 * launch with the others.
	 */
	const withoutOwnErrors = async (
		items: BurstItem[],
		routes: ResultRoute[],
		preparedTasks?: TaskParam[],
	): Promise<BurstItem[]> => {
		const errors = await Promise.all(
			items.map((item, index) => {
				const { start, length } = routes[index]!;
				return input
					.ownError(item.params, item.ctx, preparedTasks?.slice(start, start + length))
					.catch(() => undefined);
			}),
		);
		items.forEach((item, index) => {
			const error = errors[index];
			if (error) resolveItem(item, error);
		});
		return items.filter((item, index) => errors[index] === undefined && !item.settled);
	};

	const run = async (items: BurstItem[], finish: () => void): Promise<void> => {
		if (items.length === 0) {
			finish();
			return;
		}
		if (items.length === 1) {
			const item = items[0]!;
			try {
				resolveItem(item, await input.execute(item.id, item.params, item.signal, item.onUpdate, item.ctx));
			} catch (error) {
				rejectItem(item, error instanceof Error ? error : new Error(String(error)));
			} finally {
				finish();
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
			finish();
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
		// A merged run fails as a whole, before any child starts, when one launch fails on its own. Each launch that does
		// gets its own error, and the others, none of which started, run once without it. An error no launch has on its
		// own, such as too many tasks altogether, stays the error of every launch.
		let retry: BurstItem[] | undefined;
		let preparedTasks: TaskParam[] | undefined;
		merged.params![BURST_PREPARED_TASKS] = (tasks) => {
			preparedTasks = tasks;
		};
		try {
			const result = await input.execute(first.id, merged.params!, first.signal, onUpdate, first.ctx);
			if (failedBeforeStart(result)) {
				const rest = await withoutOwnErrors(items, merged.routes!, preparedTasks);
				if (rest.length < items.length) {
					releaseBurstDisplay(display);
					retry = rest;
				}
			}
			if (retry === undefined) {
				updateBurstDisplay(display, result);
				const projections = await Promise.all(
					items.map(
						async (item, index) =>
							(await projectOwnerResult(result, merged.routes![index]!, item, first.ctx)) ??
							projectResult(result, merged.routes![index]!),
					),
				);
				for (let index = 0; index < items.length; index++) resolveItem(items[index]!, projections[index]!);
			}
		} catch (error) {
			const rejection = error instanceof Error ? error : new Error(String(error));
			for (const item of items) rejectItem(item, rejection);
		} finally {
			cleanupLaterAborts();
			if (retry === undefined) finish();
		}
		if (retry !== undefined) await run(retry, finish);
	};

	const runBurst = (items: BurstItem[]): void => {
		input.setActive(true);
		const burst = items.length > 1 ? items.map(collectMixedCall) : items;
		const groups = byLegacyWait(burst);
		// A burst whose calls merge runs as one, as every burst does. Only calls that passed different `wait` values and
		// cannot merge launch by `wait` as separate runs, side by side, as they did before every launch ran in the
		// background; otherwise a field they do not share would fail them all (#5686). Each keeps its collected task list,
		// so a call with both `agent` and `tasks` launches all of its children also when it is alone in its group.
		const runs = groups.length > 1 && mergeBurst(burst).error !== undefined ? groups : [burst];
		// The last run to finish frees the executor in the same step, so a call made once its result arrives is not
		// refused as a duplicate.
		let remaining = runs.length;
		const finish = (): void => {
			if (--remaining === 0) input.setActive(false);
		};
		for (const items of runs) void run(items, finish);
	};

	const flush = (): void => {
		flushScheduled = false;
		const items = queue;
		queue = [];
		void runBurst(items);
	};

	return (id, params, signal, onUpdate, ctx, legacyWait) => {
		if (input.isActive()) return Promise.resolve(input.duplicateResult(params));
		return new Promise<SubagentToolResult>((resolve, reject) => {
			queue.push({ id, params, signal, onUpdate, ctx, settled: false, resolve, reject, legacyWait });
			if (!flushScheduled) {
				flushScheduled = true;
				setImmediate(flush);
			}
		});
	};
}
