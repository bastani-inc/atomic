const WORKFLOW_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_TARGET_PREFIX = "workflow:";

export type WorkflowStageTargetKind = "path" | "pattern" | "deep-pattern";

export interface WorkflowStageTarget {
	readonly rootRunId: string;
	readonly segments: string[];
	readonly kind: WorkflowStageTargetKind;
}

/** Most `/` segments a workflow-stage target may carry (#4843). Real stage paths stay far below this. */
export const MAX_WORKFLOW_STAGE_TARGET_SEGMENTS = 64;
/** Most characters a whole `workflow:<rootRunId>/...` target may carry (#4843). */
export const MAX_WORKFLOW_STAGE_TARGET_LENGTH = 1024;

/**
 * Why a `workflow:` target is too large to route (#4843), or `undefined` when it is within
 * limits or not a workflow target. Bounds the work every sticky pattern costs the broker.
 */
export function workflowStageTargetSizeError(target: string): string | undefined {
	if (!target.startsWith(WORKFLOW_TARGET_PREFIX)) return undefined;
	if (target.length > MAX_WORKFLOW_STAGE_TARGET_LENGTH) {
		return `Workflow-stage target is ${target.length} characters long; targets may be at most ${MAX_WORKFLOW_STAGE_TARGET_LENGTH} characters.`;
	}
	const segmentCount = target.split("/").length - 1;
	if (segmentCount > MAX_WORKFLOW_STAGE_TARGET_SEGMENTS) {
		return `Workflow-stage target has ${segmentCount} segments; targets may have at most ${MAX_WORKFLOW_STAGE_TARGET_SEGMENTS} segments.`;
	}
	return undefined;
}

/** Parse the canonical root-anchored workflow-stage target grammar. */
export function parseWorkflowStageTarget(target: string): WorkflowStageTarget | undefined {
	if (!target.startsWith(WORKFLOW_TARGET_PREFIX) || workflowStageTargetSizeError(target) !== undefined)
		return undefined;
	const slash = target.indexOf("/", WORKFLOW_TARGET_PREFIX.length);
	if (slash < 0) return undefined;
	const rootRunId = target.slice(WORKFLOW_TARGET_PREFIX.length, slash);
	if (!WORKFLOW_RUN_ID_PATTERN.test(rootRunId)) return undefined;
	const segments = target.slice(slash + 1).split("/");
	if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return undefined;
	const kind = segments.includes("**")
		? "deep-pattern"
		: segments.some((segment) => segment.includes("*"))
			? "pattern"
			: "path";
	return { rootRunId, segments, kind };
}

export function formatWorkflowStageTarget(rootRunId: string, ...segments: readonly string[]): string {
	return `${WORKFLOW_TARGET_PREFIX}${rootRunId}/${segments.join("/")}`;
}

export function withWorkflowStageTargetFinalSegment(target: string, segment: string): string | undefined {
	const parsed = parseWorkflowStageTarget(target);
	if (parsed === undefined || segment.length === 0 || segment.includes("/")) return undefined;
	return formatWorkflowStageTarget(parsed.rootRunId, ...parsed.segments.slice(0, -1), segment);
}
