const WORKFLOW_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_TARGET_PREFIX = "workflow:";

export type WorkflowStageTargetKind = "path" | "pattern" | "deep-pattern";

export interface WorkflowStageTarget {
	readonly rootRunId: string;
	readonly segments: string[];
	readonly kind: WorkflowStageTargetKind;
}

export interface LegacyWorkflowStageTarget {
	readonly runId: string;
	readonly stageKey: string;
}

/** Parse the canonical root-anchored workflow-stage target grammar. */
export function parseWorkflowStageTarget(target: string): WorkflowStageTarget | undefined {
	if (!target.startsWith(WORKFLOW_TARGET_PREFIX)) return undefined;
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

/** Detect the removed pre-D8 `<runId>:<stageKey>` grammar for migration errors only. */
export function parseLegacyWorkflowStageTarget(target: string): LegacyWorkflowStageTarget | undefined {
	const separator = target.indexOf(":");
	if (separator < 0) return undefined;
	const runId = target.slice(0, separator);
	const stageKey = target.slice(separator + 1);
	return WORKFLOW_RUN_ID_PATTERN.test(runId) && stageKey.length > 0 ? { runId, stageKey } : undefined;
}

export function formatWorkflowStageTarget(rootRunId: string, ...segments: readonly string[]): string {
	return `${WORKFLOW_TARGET_PREFIX}${rootRunId}/${segments.join("/")}`;
}

export function withWorkflowStageTargetFinalSegment(target: string, segment: string): string | undefined {
	const parsed = parseWorkflowStageTarget(target);
	if (parsed === undefined || segment.length === 0 || segment.includes("/")) return undefined;
	return formatWorkflowStageTarget(parsed.rootRunId, ...parsed.segments.slice(0, -1), segment);
}

export function legacyWorkflowStageTargetMigrationHint(canonicalTarget?: string): string {
	const base =
		"Legacy workflow-stage targets in the `<runId>:<stageKey>` form are no longer supported. Use the canonical `workflow:<rootRunId>/<segment>` path form.";
	return canonicalTarget === undefined ? base : `${base} Use \`${canonicalTarget}\` for this stage.`;
}
