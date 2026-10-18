import type { RunDetail } from "../runs/background/run-inspect.js";
import type { PendingPrompt, StageInputRequest } from "../shared/store-types.js";
import type { WorkflowOutputValues } from "../shared/types.js";

/** One stage or `ctx.tool` node that is preventing the run from finishing. */
export interface WorkflowStatusBlocker {
	readonly kind: "awaiting_input" | "failed" | "blocked";
	readonly node: "stage" | "tool";
	/** Expanded-graph stage id (valid for `answer`, `stage`, `resume`) or tool node id. */
	readonly id: string;
	readonly name: string;
	/** Pending prompt id; pass as `promptId` to `answer` when responding. */
	readonly promptId?: string;
	/** Prompt text for awaiting-input blockers, failure text otherwise. */
	readonly message?: string;
}

/**
 * Compact form of one run's detail returned by `workflow({ action: "status", runId, summary: true })`:
 * status, final outputs and blockers, without the stage and tool history.
 */
export interface WorkflowRunStatusDigest {
	readonly runId: string;
	readonly name: string;
	readonly status: RunDetail["status"];
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	/** Final outputs of the run, absent while it has none. */
	readonly result?: WorkflowOutputValues;
	readonly error?: string;
	readonly exitReason?: string;
	readonly resumable?: boolean;
	readonly resumeGuidance?: string;
	readonly ownerActiveElsewhere?: true;
	/** Empty for runs that completed, were cancelled or were killed. */
	readonly blockers: readonly WorkflowStatusBlocker[];
}

function promptMessage(prompt: PendingPrompt | undefined, request: StageInputRequest | undefined): string | undefined {
	return prompt === undefined ? request?.questions[0]?.question : prompt.message;
}

function blockers(detail: RunDetail): WorkflowStatusBlocker[] {
	if (["completed", "skipped", "cancelled", "killed"].includes(detail.status)) return [];
	const entries: WorkflowStatusBlocker[] = [];
	for (const stage of detail.stages) {
		const awaitingInput =
			stage.status === "awaiting_input" || stage.pendingPrompt !== undefined || stage.inputRequest !== undefined;
		if (!awaitingInput && stage.status !== "failed" && stage.status !== "blocked") continue;
		const message = awaitingInput ? promptMessage(stage.pendingPrompt, stage.inputRequest) : stage.error;
		const promptId = stage.pendingPrompt?.id ?? stage.inputRequest?.id;
		entries.push({
			kind: awaitingInput ? "awaiting_input" : stage.status === "failed" ? "failed" : "blocked",
			node: "stage",
			id: stage.id,
			name: stage.name,
			...(promptId === undefined ? {} : { promptId }),
			...(message === undefined ? {} : { message }),
		});
	}
	for (const tool of detail.tools) {
		if (tool.status !== "failed") continue;
		entries.push({
			kind: "failed",
			node: "tool",
			id: tool.id,
			name: tool.name,
			...(tool.error === undefined ? {} : { message: tool.error }),
		});
	}
	return entries;
}

/** Reduce a run detail to its status, outputs and blockers. */
export function buildWorkflowRunStatusDigest(detail: RunDetail): WorkflowRunStatusDigest {
	return {
		runId: detail.runId,
		name: detail.name,
		status: detail.status,
		startedAt: detail.startedAt,
		...(detail.endedAt === undefined ? {} : { endedAt: detail.endedAt }),
		...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
		...(detail.result === undefined ? {} : { result: detail.result }),
		...(detail.error === undefined ? {} : { error: detail.error }),
		...(detail.exitReason === undefined ? {} : { exitReason: detail.exitReason }),
		...(detail.resumable === undefined ? {} : { resumable: detail.resumable }),
		...(detail.resumeGuidance === undefined ? {} : { resumeGuidance: detail.resumeGuidance }),
		...(detail.ownerActiveElsewhere === true ? { ownerActiveElsewhere: true as const } : {}),
		blockers: blockers(detail),
	};
}
