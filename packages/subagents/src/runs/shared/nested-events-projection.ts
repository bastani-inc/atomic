import * as path from "node:path";
import { APP_NAME } from "@bastani/atomic";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	type AsyncJobState,
	type AsyncStatus,
	type NestedRunSummary,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";
import {
	MAX_NESTED_CHILDREN,
	MAX_NESTED_STEPS,
	NESTED_RUNS_DIR,
	assertSafeId,
	containedPath,
} from "./nested-events-core.ts";
import { projectNestedEvents } from "./nested-events-registry.ts";
import { terminal } from "./nested-events-sanitize.ts";

export function attachRootChildrenToSteps<T extends { children?: NestedRunSummary[]; index?: number }>(rootRunId: string, steps: T[] | undefined, children: NestedRunSummary[] | undefined): void {
	if (!steps?.length) return;
	for (const step of steps) {
		step.children = undefined;
	}
	if (!children?.length) return;
	for (const child of children) {
		if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
		const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
		if (!step) continue;
		step.children ??= [];
		step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(0, MAX_NESTED_CHILDREN);
	}
}

export function updateAsyncJobNestedProjection(job: AsyncJobState): void {
	if (!job.nestedRoute) return;
	const registry = projectNestedEvents(job.nestedRoute);
	job.nestedChildren = registry.children;
	attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}

export function updateForegroundNestedProjection(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): void {
	if (!control.nestedRoute) return;
	const registry = projectNestedEvents(control.nestedRoute);
	control.nestedChildren = registry.children;
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
	if (!children?.length) return false;
	for (const child of children) {
		if (!terminal(child.state)) return true;
		if (hasLiveNestedDescendants(child.children)) return true;
		if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}

export function nestedSummaryFromAsyncStatus(status: AsyncStatus, asyncDir: string, fallback: { id: string; parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }>; mode?: SubagentRunMode; ts: number }): NestedRunSummary {
	return {
		id: status.runId || fallback.id,
		parentRunId: fallback.parentRunId,
		...(fallback.parentStepIndex !== undefined ? { parentStepIndex: fallback.parentStepIndex } : {}),
		depth: fallback.depth,
		path: fallback.path ?? [{ runId: fallback.parentRunId, ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}) }],
		asyncDir,
		...(status.pid ? { pid: status.pid } : {}),
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		mode: status.mode ?? fallback.mode,
		state: status.state,
		...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(status.activityState ? { activityState: status.activityState } : {}),
		...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
		...(status.currentTool ? { currentTool: status.currentTool } : {}),
		...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
		...(status.currentPath ? { currentPath: status.currentPath } : {}),
		...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
		...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.startedAt !== undefined ? { startedAt: status.startedAt } : { startedAt: fallback.ts }),
		...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
		lastUpdate: status.lastUpdate ?? fallback.ts,
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
		...(status.steps?.length ? { steps: status.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.activityState ? { activityState: step.activityState } : {}),
			...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
			...(step.error ? { error: step.error } : {}),
		})).slice(0, MAX_NESTED_STEPS) } : {}),
	};
}

export function nestedArtifactEnv(rootRunId: string, parentRunId: string): Record<string, string> {
	const envPrefix = APP_NAME.toUpperCase();
	return {
		[`${envPrefix}_SUBAGENT_NESTED_ROOT_RUN_ID`]: rootRunId,
		[`${envPrefix}_SUBAGENT_NESTED_PARENT_RUN_ID`]: parentRunId,
	};
}

export function isTopLevelAsyncDir(asyncDir: string): boolean {
	const resolved = path.resolve(asyncDir);
	return containedPath(ASYNC_DIR, resolved) && !containedPath(NESTED_RUNS_DIR, resolved);
}

export function nestedResultsPath(rootRunId: string, id: string): string {
	assertSafeId("rootRunId", rootRunId);
	assertSafeId("id", id);
	return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
