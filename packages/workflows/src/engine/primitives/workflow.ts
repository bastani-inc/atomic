import type { DurableChildInvocation } from "../../durable/boundary-topology.js";
import {
	findWorkflowExitSignal,
	isWorkflowExitStatus,
	makeParentWorkflowExitAbortReason,
} from "../../runs/foreground/executor-abort.js";
import {
	isWorkflowDefinition,
	workflowChildReplaySnapshot,
	workflowDefinitionRequirementMessage,
} from "../../runs/foreground/executor-child-helpers.js";
import { resolveAndValidateInputs } from "../../runs/foreground/executor-inputs.js";
import { selectWorkflowOutputs } from "../../runs/foreground/executor-outputs.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../../runs/foreground/executor-types.js";
import type { WorkflowChildRunRef } from "../../shared/store-types.js";
import type {
	WorkflowChildResult,
	WorkflowDefinition,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowRunChildArgs,
	WorkflowRunChildOptions,
} from "../../shared/types.js";
import type { EngineRuntime } from "../runtime.js";
import {
	findWorkflowGracefulQuit,
	WORKFLOW_GRACEFUL_QUIT_EXIT_REASON,
	WorkflowGracefulQuitError,
} from "../workflow-tool-abort.js";

export function createChildWorkflowRunner(input: {
	readonly runtime: EngineRuntime;
	readonly resolveWorkflowCwd: () => string;
	readonly nextWorkflowBoundaryReplayKey: (name: string) => string;
	/** Consume the identity prepared by the durable outer primitive. */
	readonly consumeDurableInvocation?: () => DurableChildInvocation | undefined;
	readonly runWorkflow: <TInputs extends WorkflowInputValues, TRunInputs extends WorkflowInputValues = TInputs>(
		def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
		inputs: ResolvedInputs,
		opts?: RunOpts,
	) => Promise<RunResult>;
}): <
	TChildInputs extends WorkflowInputValues,
	TChildOutputs extends WorkflowOutputValues,
	TChildRunInputs extends WorkflowInputValues = TChildInputs,
>(
	child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
	...args: WorkflowRunChildArgs<TChildRunInputs>
) => Promise<WorkflowChildResult<TChildOutputs>> {
	return async <
		TChildInputs extends WorkflowInputValues,
		TChildOutputs extends WorkflowOutputValues,
		TChildRunInputs extends WorkflowInputValues = TChildInputs,
	>(
		child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
		...args: WorkflowRunChildArgs<TChildRunInputs>
	): Promise<WorkflowChildResult<TChildOutputs>> => {
		const options: WorkflowRunChildOptions<TChildRunInputs> = args[0] ?? {};
		const { runtime } = input;
		runtime.exit.throwIfWorkflowExitSelected();
		if (!isWorkflowDefinition(child))
			throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
		const childName = child.normalizedName;
		const boundaryName = options.stageName ?? `workflow:${childName}`;
		const boundaryReplayKey = input.nextWorkflowBoundaryReplayKey(boundaryName);
		const durableInvocation = input.consumeDurableInvocation?.();
		const boundary = runtime.spawnStage(boundaryName, {
			kind: "workflow-boundary",
			replayKey: boundaryReplayKey,
			...(durableInvocation !== undefined ? { identity: durableInvocation.identity } : {}),
		}).boundary;
		if (boundary.replayedChild !== undefined) {
			durableInvocation?.adoptReplayedChildRunId(boundary.replayedChild.runId);
		}
		await durableInvocation?.recordStart(boundary.parentIds, boundary.sourceOrder);
		let childRunId: string | undefined;
		let detachParentAbort: (() => void) | undefined;
		let childControllerForCleanup: AbortController | undefined;
		try {
			if (boundary.replayedChild !== undefined) {
				await Promise.resolve();
				runtime.exit.throwIfWorkflowExitSelected();
				boundary.finalizeReplay();
				await durableInvocation?.recordTerminal("completed", boundary.replayedChild);
				return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
			}

			const childInputs = resolveAndValidateInputs(
				child.inputs,
				options.inputs ?? {},
				`child workflow "${childName}" (${child.name})`,
			);
			runtime.exit.throwIfWorkflowExitSelected();

			childRunId = durableInvocation?.identity.childRunId ?? crypto.randomUUID();
			const childController = new AbortController();
			childControllerForCleanup = childController;
			const childRef: WorkflowChildRunRef = { alias: childName, workflow: child.normalizedName, runId: childRunId };
			boundary.linkChildRun(childRef, childController);

			const abortChildFromParent = (): void => {
				const parentExit = findWorkflowExitSignal(runtime.signal.reason, runtime.exit.exitScope);
				childController.abort(
					parentExit !== undefined ? makeParentWorkflowExitAbortReason(parentExit.reason) : runtime.signal.reason,
				);
			};
			if (runtime.signal.aborted) abortChildFromParent();
			else {
				runtime.signal.addEventListener("abort", abortChildFromParent, { once: true });
				detachParentAbort = () => runtime.signal.removeEventListener("abort", abortChildFromParent);
			}
			runtime.exit.throwIfWorkflowExitSelected();
			runtime.childRunOptions.cancellation?.register(childRunId, childController);
			runtime.exit.throwIfWorkflowExitSelected();

			// Ordering is intentional: linkChildRun happens before launch so parent
			// cleanup can abort the child; observeChildRun happens immediately after
			// promise creation, with no await in between, so cleanup can await teardown.
			const childRunPromise = input.runWorkflow(child, childInputs, {
				...runtime.childRunOptions,
				runId: childRunId,
				cwd: input.resolveWorkflowCwd(),
				depth: runtime.depth + 1,
				parentRun: {
					runId: runtime.runId,
					stageId: boundary.id,
					rootRunId: runtime.parentRootRunId ?? runtime.runId,
				},
				signal: childController.signal,
				deferWorkflowStart: false,
				...(durableInvocation !== undefined ? { durableScope: durableInvocation.scope } : {}),
			});
			boundary.observeChildRun(childRunPromise);
			const childRun = await childRunPromise;
			runtime.exit.throwIfWorkflowExitSelected();

			// A gracefully quit child is a suspension, not a child failure: carry the
			// quit up so the parent also suspends without a terminal boundary record.
			if (
				childRun.status === "paused" &&
				childRun.exitReason === WORKFLOW_GRACEFUL_QUIT_EXIT_REASON &&
				childRunId !== undefined
			) {
				throw new WorkflowGracefulQuitError(childRunId, `child workflow "${childName}" (${child.name})`);
			}
			if (!isWorkflowExitStatus(childRun.status) || (childRun.status === "failed" && childRun.exited !== true)) {
				const failedChildStage = childRun.stages.find((stage) => stage.failureKind !== undefined);
				throw new Error(
					`atomic-workflows: child workflow "${childName}" (${child.name}) failed with status ${childRun.status}${childRun.error !== undefined ? `: ${childRun.error}` : ""}`,
					{
						cause: {
							...(failedChildStage?.failureKind !== undefined ? { code: failedChildStage.failureKind } : {}),
							...(failedChildStage?.failureMessage !== undefined
								? { message: failedChildStage.failureMessage }
								: {}),
						},
					},
				);
			}

			const outputs = selectWorkflowOutputs(child, childRun.result);
			const childExited = childRun.exited === true || childRun.status !== "completed";
			const childResult: WorkflowChildResult<TChildOutputs> = childExited
				? {
						workflow: child.normalizedName,
						runId: childRun.runId,
						status: childRun.status,
						exited: true,
						outputs: outputs as Partial<TChildOutputs>,
						...(childRun.exitReason !== undefined ? { exitReason: childRun.exitReason } : {}),
					}
				: {
						workflow: child.normalizedName,
						runId: childRun.runId,
						status: "completed",
						exited: false,
						outputs: outputs as TChildOutputs,
					};
			const workflowChild = workflowChildReplaySnapshot(childName, childResult);
			const outputKeys = Object.keys(outputs);
			boundary.complete(
				`Workflow "${child.name}" ${childRun.status} (runId: ${childRun.runId}; outputs: ${outputKeys.length > 0 ? outputKeys.join(", ") : "(none)"})`,
				workflowChild,
			);
			await durableInvocation?.recordTerminal("completed", childResult);
			return childResult;
		} catch (err) {
			// Suspension leaves the boundary untouched: quit owns the paused record and
			// a later resume replays this boundary instead of a failed child.
			if (findWorkflowGracefulQuit(err) !== undefined) throw err;
			const exit =
				findWorkflowExitSignal(err, runtime.exit.exitScope) ??
				findWorkflowExitSignal(runtime.signal.reason, runtime.exit.exitScope);
			if (exit !== undefined) {
				await boundary.skipForWorkflowExit(exit.reason);
				await durableInvocation?.recordTerminal("skipped");
				throw exit;
			}
			boundary.fail(err);
			await durableInvocation?.recordTerminal("failed");
			throw err;
		} finally {
			detachParentAbort?.();
			// Identity-conditional: a stale child finalizer must not evict a newer
			// registration that reused this child run id.
			if (childRunId !== undefined && childControllerForCleanup !== undefined)
				runtime.childRunOptions.cancellation?.unregister(childRunId, childControllerForCleanup);
		}
	};
}
