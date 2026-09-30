import { isDbosDependencyError } from "../durable/dbos-admission.js";
import { DbosDurabilityError } from "../durable/dbos-lifecycle.js";
import type { ResumeDurableResult } from "../durable/resume-runtime.js";
import type { ResumeFailedRunResult } from "./runtime.js";
import { WorkflowInstanceOwnershipError } from "./workflow-instance-owner.js";

/** Machine-readable reason attached to a `noop` pause, quit, or resume result that could not act on its target. */
export type WorkflowControlFailureCode =
	| "run_not_found"
	| "not_resumable"
	| "owned_elsewhere"
	| "stage_not_found"
	| "stage_ambiguous"
	| "stage_resume_unsupported"
	| "database_unavailable"
	| "control_failed";

export interface WorkflowControlFailedRun {
	readonly runId: string;
	readonly reason: string;
	readonly message?: string;
}

export function classifyControlError(error: unknown): WorkflowControlFailureCode {
	if (error instanceof WorkflowInstanceOwnershipError) return "owned_elsewhere";
	if (error instanceof DbosDurabilityError || isDbosDependencyError(error)) return "database_unavailable";
	return "control_failed";
}

type ResumeFailureReason =
	| Exclude<ResumeDurableResult, { ok: true }>["reason"]
	| Exclude<ResumeFailedRunResult, { ok: true }>["reason"];

export function resumeFailureCode(reason: ResumeFailureReason): WorkflowControlFailureCode {
	switch (reason) {
		case "not_resumable":
		case "stale":
			return "not_resumable";
		case "owned_elsewhere":
			return "owned_elsewhere";
		case "not_registered":
		case "run_not_found":
			return "run_not_found";
		case "workflow_not_found":
		case "invalid_inputs":
		case "startup_failed":
		case "insufficient_state":
			return "control_failed";
	}
}
