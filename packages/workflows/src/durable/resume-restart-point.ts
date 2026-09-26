/**
 * Where a failed run can restart from.
 *
 * This is the second question `/workflow resume` asks, after the eligibility
 * rule in `resume-eligibility.ts` has said yes: is there a usable restart
 * point? A failed stage, a system-owned budget stop with no stages (restart
 * from the workflow start), or a tool frontier that
 * `resolveToolResumeFrontier` validates. Without one the run is refused with
 * `insufficient_state`, so "eligible" and "resumable in practice" differ.
 *
 * Moved unchanged from `extension/runtime.ts` so the presentation layer can
 * ask the same question the runtime asks (#2565); the backend is a parameter,
 * as `tool-resume-frontier.ts` takes it, rather than the process global.
 */
import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { resolveToolResumeFrontier } from "./tool-resume-frontier.js";

export type ResumeRestartPoint =
	| { readonly ok: true; readonly stageId?: string; readonly toolNodeId?: string }
	| { readonly ok: false; readonly message: string };

function matchesResumeStageIdentifier(stage: RunSnapshot["stages"][number], identifier: string): boolean {
	return stage.id === identifier || stage.name === identifier;
}

function stageLabel(stage: RunSnapshot["stages"][number]): string {
	return `${stage.name} (${stage.id})`;
}

function resolveUniqueResumeStage(
	source: RunSnapshot,
	identifier: string,
): { ok: true; stage: RunSnapshot["stages"][number] } | { ok: false; message: string } {
	const exactId = source.stages.find((stage) => stage.id === identifier);
	if (exactId !== undefined) return { ok: true, stage: exactId };

	const exactNames = source.stages.filter((stage) => stage.name === identifier);
	if (exactNames.length === 1) return { ok: true, stage: exactNames[0]! };
	if (exactNames.length > 1) {
		return {
			ok: false,
			message: `insufficient_state: ambiguous stage identifier "${identifier}" matches: ${exactNames.map(stageLabel).join(", ")}`,
		};
	}

	const matches = source.stages.filter((stage) => matchesResumeStageIdentifier(stage, identifier));
	if (matches.length === 0)
		return { ok: false, message: `insufficient_state: stage not found in source run ${source.id}: ${identifier}` };
	if (matches.length > 1) {
		return {
			ok: false,
			message: `insufficient_state: ambiguous stage identifier "${identifier}" matches: ${matches.map(stageLabel).join(", ")}`,
		};
	}
	return { ok: true, stage: matches[0]! };
}

export function resolveResumeStage(
	source: RunSnapshot,
	backend: DurableWorkflowBackend | (() => DurableWorkflowBackend),
	stageId?: string,
): ResumeRestartPoint {
	// The backend is needed only to validate a tool frontier; a stage restart
	// point is decided from the snapshot alone. A caller that may run before the
	// backend is ready passes a thunk, so a stage answer never waits on it.
	const backendOf = () => (typeof backend === "function" ? backend() : backend);
	const budgetExceededSource =
		source.result?.status === "budget_exceeded" && source.budgetState?.systemOwnedStop === true;
	if (stageId !== undefined) {
		const resolved = resolveUniqueResumeStage(source, stageId);
		if (!resolved.ok) return { ok: false, message: resolved.message };
		const stage = resolved.stage;
		if (stage.status !== "failed" && !(budgetExceededSource && stage.id === source.failedStageId))
			return { ok: false, message: `insufficient_state: stage ${stage.name} is ${stage.status}, not failed` };
		return { ok: true, stageId: stage.id };
	}
	if (source.failedToolNodeId !== undefined && source.failedStageId === undefined) {
		return resolveToolResumeFrontier(source, backendOf());
	}
	const failedStageId = source.failedStageId ?? source.stages.find((stage) => stage.status === "failed")?.id;
	if (failedStageId !== undefined) return { ok: true, stageId: failedStageId };
	if (budgetExceededSource && source.stages.length === 0) return { ok: true };
	if ((source.toolNodes?.length ?? 0) > 0) return resolveToolResumeFrontier(source, backendOf());
	return { ok: false, message: `insufficient_state: failed run ${source.id} does not identify a failed stage` };
}
