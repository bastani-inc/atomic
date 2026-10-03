import {
	type SessionWorkflows,
	type WorkflowRunAllTarget,
	WorkflowRunControlError,
	type WorkflowRunControlFailedRun,
	type WorkflowRunControlOutcome,
	type WorkflowRunControlStatus,
	WorkflowRunControlUnavailableError,
	WorkflowRunDatabaseError,
	WorkflowRunNotFoundError,
	WorkflowRunNotResumableError,
	WorkflowRunOwnershipError,
	WorkflowStageAmbiguousError,
	WorkflowStageNotFoundError,
	WorkflowStageResumeUnsupportedError,
} from "@bastani/atomic";
import { isRunIdPrefix, resolveRunIdTarget } from "../shared/run-id.js";
import type { Store } from "../shared/store.js";
import type { PiEventContext, PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import { classifyControlError, type WorkflowControlFailureCode } from "./workflow-control-failure.js";

export interface SessionRunControlHost {
	/** The same executor the registered `workflow` tool runs, so ownership and durability rules are shared. */
	readonly execute: (
		args: WorkflowToolArgs,
		ctx: PiExecuteContext,
		signal?: AbortSignal,
		onRunAccepted?: (runId: string) => void,
		access?: "sdk",
	) => Promise<WorkflowToolResult>;
	/** The owning session's most recent event context, or `undefined` before it started. */
	readonly context: () => PiEventContext | undefined;
	readonly store: Pick<Store, "runs">;
}

function executeContext(ctx: PiEventContext | undefined): PiExecuteContext {
	if (ctx === undefined) throw new WorkflowRunControlUnavailableError();
	return {
		sessionId: ctx.sessionManager?.getSessionId?.(),
		sessionManager: ctx.sessionManager,
		ui: ctx.ui,
		hasUI: ctx.hasUI,
		hasHumanInput: ctx.hasHumanInput,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		cwd: ctx.cwd,
	};
}

interface ControlErrorOptions {
	runId?: string;
	cause?: Error;
	failedRuns?: readonly WorkflowRunControlFailedRun[];
}

function errorOptions(
	runId: string | undefined,
	cause?: Error,
	failedRuns?: readonly WorkflowRunControlFailedRun[],
): ControlErrorOptions {
	return {
		...(runId === undefined || runId === "--all" ? {} : { runId }),
		...(cause === undefined ? {} : { cause }),
		...(failedRuns === undefined ? {} : { failedRuns }),
	};
}

function failure(
	code: WorkflowControlFailureCode,
	message: string,
	runId: string | undefined,
	cause?: Error,
	failedRuns?: readonly WorkflowRunControlFailedRun[],
): WorkflowRunControlError {
	const options = errorOptions(runId, cause, failedRuns);
	switch (code) {
		case "run_not_found":
			return new WorkflowRunNotFoundError(message, options);
		case "not_resumable":
			return new WorkflowRunNotResumableError(message, options);
		case "owned_elsewhere":
			return new WorkflowRunOwnershipError(message, options);
		case "stage_not_found":
			return new WorkflowStageNotFoundError(message, options);
		case "stage_ambiguous":
			return new WorkflowStageAmbiguousError(message, options);
		case "stage_resume_unsupported":
			return new WorkflowStageResumeUnsupportedError(message, options);
		case "database_unavailable":
			return new WorkflowRunDatabaseError(message, options);
		case "control_failed":
			return new WorkflowRunControlError("WORKFLOW_RUN_CONTROL_FAILED", message, options);
	}
}

function translateThrown(error: Error, runId: string | undefined): Error {
	const code = classifyControlError(error);
	return code === "owned_elsewhere" || code === "database_unavailable"
		? failure(code, error.message, runId, error)
		: error;
}

function controlStatus(status: string, runId: string): WorkflowRunControlStatus {
	switch (status) {
		case "ok":
		case "running":
		case "paused":
		case "partial":
		case "noop":
		case "cancelled":
			return status;
		default:
			throw failure("control_failed", `Unexpected workflow control status: ${status}`, runId);
	}
}

function controlOutcome(result: WorkflowToolResult): WorkflowRunControlOutcome {
	if (result.action !== "pause" && result.action !== "quit" && result.action !== "resume") {
		throw failure("control_failed", `Unexpected workflow result: ${result.action}`, undefined);
	}
	if ("code" in result && result.code !== undefined) {
		throw failure(
			result.code,
			result.message,
			result.runId,
			undefined,
			"failedRuns" in result ? result.failedRuns : undefined,
		);
	}
	return { ...result, status: controlStatus(result.status, result.runId) };
}

function rejectUnknownRunPrefix(store: Pick<Store, "runs">, runId: string): void {
	const target = runId.trim();
	if (!isRunIdPrefix(target)) return;
	const resolution = resolveRunIdTarget(
		target,
		store.runs().map((run) => run.id),
	);
	if (resolution.kind === "not_found") {
		throw failure(
			"run_not_found",
			`Run not found: ${target} (no run in this session has that prefix; pass the full run id for a run recorded elsewhere).`,
			runId,
		);
	}
}

/** Typed run control for one session, delegating every action to the workflow tool's own executor. */
export function createSessionRunControl(host: SessionRunControlHost): SessionWorkflows {
	const request = async (args: WorkflowToolArgs): Promise<WorkflowToolResult> => {
		try {
			const ctx = executeContext(host.context());
			if (args.runId !== undefined && (args.action === "status" || args.action === "stages"))
				rejectUnknownRunPrefix(host.store, args.runId);
			return await host.execute(args, ctx, undefined, undefined, "sdk");
		} catch (error) {
			throw error instanceof Error ? translateThrown(error, args.runId) : error;
		}
	};
	const target = (runId: string | WorkflowRunAllTarget): Pick<WorkflowToolArgs, "runId" | "all"> =>
		typeof runId === "string" ? { runId } : { all: true };

	return {
		async listRuns(filter) {
			const result = await request({
				action: "status",
				...(filter?.status === undefined ? {} : { statusFilter: filter.status }),
			});
			if (result.action !== "status")
				throw failure("control_failed", `Unexpected workflow result: ${result.action}`, undefined);
			return result.runs;
		},
		async getRun(runId) {
			const result = await request({ action: "status", runId });
			if (result.action !== "statusDetail")
				throw failure("control_failed", `Unexpected workflow result: ${result.action}`, runId);
			if ("error" in result) throw failure("run_not_found", result.error, runId);
			return result.detail;
		},
		async getStages(runId, filter) {
			const result = await request({
				action: "stages",
				runId,
				...(filter?.status === undefined ? {} : { statusFilter: filter.status }),
			});
			if (result.action !== "stages")
				throw failure("control_failed", `Unexpected workflow result: ${result.action}`, runId);
			if (result.error !== undefined) throw failure("run_not_found", result.error, runId);
			return result.stages;
		},
		async pause(runId: string | WorkflowRunAllTarget, options?: { readonly stageId?: string }) {
			return controlOutcome(
				await request({
					action: "pause",
					...target(runId),
					...(options?.stageId === undefined ? {} : { stageId: options.stageId }),
				}),
			);
		},
		async quit(runId) {
			return controlOutcome(await request({ action: "quit", ...target(runId) }));
		},
		async resume(runId, options) {
			return controlOutcome(
				await request({
					action: "resume",
					runId,
					...(options?.stageId === undefined ? {} : { stageId: options.stageId }),
					...(options?.message === undefined ? {} : { message: options.message }),
				}),
			);
		},
	};
}
