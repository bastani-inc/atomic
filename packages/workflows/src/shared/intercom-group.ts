import { randomUUID } from "node:crypto";
import type { StageOptions } from "./types.js";

/** The implicit group shared by every ungrouped session. */
export const DEFAULT_INTERCOM_GROUP = "default";

/** Stable non-default home group for every stage in one top-level workflow invocation. */
export function workflowInvocationIntercomGroup(rootRunId: string): string {
	return `workflow:${rootRunId}`;
}

/** Normalize authored or agent-serialized auto-group sentinels without changing real group names. */
export function normalizeAutoGroupSentinel(group: string | true): string | true {
	if (group === true) return true;
	const sentinel = group.trim().toLowerCase();
	return sentinel === "true" || sentinel === "auto" ? true : group;
}

/** Trim; empty/undefined collapses to the shared default group. */
export function normalizeGroup(value?: string | null): string {
	if (typeof value !== "string") return DEFAULT_INTERCOM_GROUP;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_INTERCOM_GROUP;
}

/** Resolve explicit workflow groups as invocation-owned subgroups, except for the documented default escape. */
export function resolveStageGroup(
	stageOptions?: { group?: string | true },
	workflowGroup?: string,
): string | undefined {
	if (!stageOptions) return workflowGroup;
	const group = stageOptions.group;
	if (group === undefined) return workflowGroup;
	const authored = group === true ? randomUUID() : group.trim();
	if (authored.length === 0) return undefined;
	if (workflowGroup === undefined || authored === DEFAULT_INTERCOM_GROUP) return authored;
	const owner = normalizeGroup(workflowGroup);
	if (authored === owner || authored.startsWith(`${owner}/`)) return authored;
	return `${owner}/${authored}`;
}

/** True when a group is the invocation group itself or one of its broker-recognizable owned subgroups. */
export function workflowInvocationOwnsGroup(workflowGroup: string | undefined, candidate: string | undefined): boolean {
	if (workflowGroup === undefined || candidate === undefined) return false;
	const owner = normalizeGroup(workflowGroup);
	const group = normalizeGroup(candidate);
	return group === owner || group.startsWith(`${owner}/`);
}

/** Every workflow model stage has ordinary Intercom access. */
export function stageHasIntercomAccess(_stageOptions?: StageOptions): boolean {
	return true;
}

/** Whether a stage can present the workflow owner's durable pending/live route. */
export function stageCanUseWorkflowPendingStageRoute(
	stageOptions: StageOptions | undefined,
	workflowGroup: string | undefined,
): boolean {
	return (
		stageHasIntercomAccess(stageOptions) &&
		workflowInvocationOwnsGroup(workflowGroup, resolveStageGroup(stageOptions, workflowGroup))
	);
}
