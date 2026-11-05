import type { ForkError, ForkErrorCode } from "../durable/fork-errors.js";
import { isForkError } from "../durable/fork-errors.js";
import { validateForkOptions } from "../durable/fork-run.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { ForkResult } from "./render-result.js";
import type { ExtensionRuntime } from "./runtime.js";

export interface WorkflowForkActionDeps {
	readonly getRuntime: () => ExtensionRuntime;
	readonly policy: WorkflowExecutionPolicy;
	readonly source: "sdk" | "cli";
	readonly modelOwner?: string;
	readonly signal?: AbortSignal;
	readonly onRunAccepted?: (runId: string) => void;
}

function forkFailure(sourceRunId: string, error: ForkError): ForkResult {
	return {
		action: "fork",
		runId: "",
		sourceRunId,
		status: "failed",
		message: error.message,
		code: error.code as ForkErrorCode,
		hint: error.hint,
	};
}

/**
 * The `fork` action of the `workflow` tool and `/workflow fork`: fork a durable run into this
 * session's directory, optionally from a stage with replacement inputs, and run the fork in the
 * background. Empty `inputs`, the schema's default, keep the source run's inputs. A failure is the
 * typed fork error's code, message and hint; nothing is written.
 */
export async function workflowForkAction(
	args: Pick<WorkflowToolArgs, "runId" | "fromStage" | "inputs" | "carryMessages">,
	deps: WorkflowForkActionDeps,
): Promise<ForkResult> {
	const sourceRunId = args.runId?.trim() ?? "";
	try {
		validateForkOptions(deps.source, sourceRunId, {
			fromStage: args.fromStage,
			inputs: args.inputs,
			carryMessages: args.carryMessages,
		});
	} catch (error) {
		if (isForkError(error)) return forkFailure(sourceRunId, error);
		throw error;
	}
	const replacement = args.inputs === undefined || Object.keys(args.inputs).length === 0 ? undefined : args.inputs;
	const forked = await deps.getRuntime().forkDurableWorkflow(sourceRunId, {
		source: deps.source,
		fromStage: args.fromStage,
		inputs: replacement,
		carryMessages: args.carryMessages,
		policy: deps.policy,
		modelOwner: deps.modelOwner,
		signal: deps.signal,
		onRunAccepted: deps.onRunAccepted,
	});
	if (!forked.ok) return forkFailure(sourceRunId, forked.error);
	return {
		action: "fork",
		runId: forked.runId,
		sourceRunId: forked.forkedFrom.runId,
		status: forked.started ? "running" : "forked",
		message: forked.message,
		forkedFrom: forked.forkedFrom,
		...(forked.startFailure === undefined ? {} : { startFailure: forked.startFailure }),
	};
}
