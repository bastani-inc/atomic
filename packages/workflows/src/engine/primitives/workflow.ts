import { existsSync } from "node:fs";
import {
	acquireWorkspaceWriterLease,
	type BoundWorkspace,
	isBoundWorkspace,
	isWorkspaceRestoreError,
	resolveWorkspace,
	restoreWorkspace,
	type Workspace,
	type WorktreeRootMapping,
	workspaceChangeSet,
} from "@bastani/atomic";
import type { DurableChildInvocation } from "../../durable/boundary-topology.js";
import { mapWorkflowWorktreePath } from "../../durable/worktree-snapshots.js";
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
import { recordedFailureClassification } from "../../runs/foreground/executor-lifecycle.js";
import { selectWorkflowOutputs } from "../../runs/foreground/executor-outputs.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../../runs/foreground/executor-types.js";
import { readSerializedError } from "../../shared/error-codec.js";
import type { WorkflowChildRunRef } from "../../shared/store-types.js";
import type {
	WorkflowChildResult,
	WorkflowDefinition,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowRunChildArgs,
	WorkflowRunChildOptions,
} from "../../shared/types.js";
import { classifyFailureAsRecorded, classifyFailureFrom } from "../../shared/workflow-failures-classifier.js";
import { childWorkerDispatcher } from "../../workers/dispatch.js";
import type { EngineRuntime } from "../runtime.js";
import {
	findWorkflowGracefulQuit,
	WORKFLOW_GRACEFUL_QUIT_EXIT_REASON,
	WorkflowGracefulQuitError,
} from "../workflow-tool-abort.js";
import { childWorkflowFailureMessage, withoutChildWorkflowFailurePrefixes } from "./child-workflow-failure-message.js";

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
		if (runtime.budget.enabled) await runtime.budget.stopAtBoundaryAsync(boundaryName);
		const boundary = runtime.spawnStage(boundaryName, {
			kind: "workflow-boundary",
			replayKey: boundaryReplayKey,
			...(durableInvocation !== undefined ? { identity: durableInvocation.identity } : {}),
		}).boundary;
		if (boundary.replayedChild !== undefined) {
			durableInvocation?.adoptReplayedChildRunId(boundary.replayedChild.runId);
		}
		// A run bound read-only is a ceiling for everything nested in it.
		const inherited = runtime.inputRuntimeDefaults.workspace;
		const readOnlyCeiling = isBoundWorkspace(inherited) && inherited.sandbox === "read-only" ? inherited : undefined;
		if (options.workspace !== undefined && boundary.replayedChild === undefined && durableInvocation !== undefined) {
			try {
				await bindChildWorkspace(
					readOnlyCeiling === undefined ? options.workspace : options.workspace.readOnly(),
					durableInvocation,
					runtime.signal,
					`${runtime.runId}/${boundaryName}`,
					runtime.childRunOptions.worktreeRootMappings ?? [],
				);
			} catch (err) {
				// The boundary has no durable start yet: settle it in memory only, as the catch below does once started.
				if (findWorkflowGracefulQuit(err) !== undefined) throw err;
				const exit =
					findWorkflowExitSignal(err, runtime.exit.exitScope) ??
					findWorkflowExitSignal(runtime.signal.reason, runtime.exit.exitScope);
				if (exit !== undefined) {
					await boundary.skipForWorkflowExit(exit.reason);
					throw exit;
				}
				await boundary.fail(err);
				throw err;
			}
		}
		const workspace = durableInvocation?.workspace;
		await durableInvocation?.recordStart(boundary.parentIds, boundary.sourceOrder);
		let childRunId: string | undefined;
		let detachParentAbort: (() => void) | undefined;
		let childControllerForCleanup: AbortController | undefined;
		try {
			if (boundary.replayedChild !== undefined) {
				await Promise.resolve();
				runtime.exit.throwIfWorkflowExitSelected();
				await boundary.finalizeReplay();
				await durableInvocation?.recordTerminal("completed", boundary.replayedChild);
				return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
			}

			runtime.assertLiveWorkAllowed?.();
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
			await boundary.linkChildRun(childRef, childController);

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
			const dispatcher =
				runtime.parentRootRunId === undefined && runtime.childRunOptions.durableRootBackend
					? childWorkerDispatcher(runtime.childRunOptions.durableRootBackend, runtime.runId)
					: undefined;
			const runChild = dispatcher === undefined ? input.runWorkflow : dispatcher.run.bind(dispatcher);
			const childRunPromise = runChild(child, childInputs, {
				...runtime.childRunOptions,
				runId: childRunId,
				cwd: workspace?.worktree ?? input.resolveWorkflowCwd(),
				workspace: workspace ?? readOnlyCeiling,
				depth: runtime.depth + 1,
				parentRun: {
					runId: runtime.runId,
					stageId: boundary.id,
					rootRunId: runtime.parentRootRunId ?? runtime.runId,
				},
				signal: childController.signal,
				budget: options.budget,
				rootBudget: runtime.rootBudget,
				deferWorkflowStart: false,
				...(durableInvocation !== undefined ? { durableScope: durableInvocation.scope } : {}),
			});
			boundary.observeChildRun(childRunPromise);
			const childRun = await childRunPromise;
			if (runtime.budget.enabled) await runtime.budget.stopAtBoundaryAsync(boundaryName);
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
			const childBudgetExceeded = childRun.result?.status === "budget_exceeded";
			const childExitStatus = isWorkflowExitStatus(childRun.status) ? childRun.status : "blocked";
			if (
				(!isWorkflowExitStatus(childRun.status) && !childBudgetExceeded) ||
				(childRun.status === "failed" && childRun.exited !== true)
			) {
				const failedChildStage = childRun.stages.find((stage) => stage.failureKind !== undefined);
				const message = childWorkflowFailureMessage(childName, child.name, childRun.status, childRun.error);
				// #4309, #4378: a typed error the child failed on crosses back as itself, so guards such as
				// findStageWaitError match the parent's failure. A pooled child's detail is another process's input: one
				// that cannot be read is reported once and left out.
				const typed =
					childRun.failureDetail === undefined ? undefined : readSerializedError(childRun.failureDetail);
				if (typed?.ok === false)
					runtime.activeStore.recordNotice({
						id: `child-failure-detail-ignored:${runtime.runId}:${boundary.id}`,
						runId: runtime.runId,
						stageId: boundary.id,
						level: "warning",
						message: `Child workflow "${childName}" reported a typed failure that could not be read (${typed.error.field} is not ${typed.error.expected}); its failure is kept as text only.`,
						createdAt: Date.now(),
					});
				const cause = {
					...(failedChildStage?.failureKind !== undefined ? { code: failedChildStage.failureKind } : {}),
					...(failedChildStage?.failureMessage !== undefined ? { message: failedChildStage.failureMessage } : {}),
					...(typed?.ok === true ? { cause: typed.error } : {}),
				};
				// #4031: the parent's failure is the child's own failure: the classification the child recorded, else its
				// failed stage's, else its error text without the wrapper prefixes that name workflows. This message,
				// which names them, never decides it.
				const failure = new Error(message, { cause });
				const recorded =
					childRun.failure ??
					(failedChildStage === undefined ? undefined : recordedFailureClassification(failedChildStage));
				if (recorded !== undefined) throw classifyFailureAsRecorded(failure, recorded);
				throw classifyFailureFrom(failure, new Error(withoutChildWorkflowFailurePrefixes(childRun.error ?? "")));
			}

			const outputs = selectWorkflowOutputs(child, childRun.result);
			const childExited = childBudgetExceeded || childRun.exited === true || childRun.status !== "completed";
			const changeSet =
				workspace === undefined ? undefined : await workspaceChangeSet(workspace, { signal: runtime.signal });
			const childResult: WorkflowChildResult<TChildOutputs> = childExited
				? {
						workflow: child.normalizedName,
						runId: childRun.runId,
						status: childBudgetExceeded ? "blocked" : childExitStatus,
						exited: true,
						outputs: outputs as Partial<TChildOutputs>,
						...(childRun.exitReason !== undefined ? { exitReason: childRun.exitReason } : {}),
						...(changeSet !== undefined ? { changeSet } : {}),
					}
				: {
						workflow: child.normalizedName,
						runId: childRun.runId,
						status: "completed",
						exited: false,
						outputs: outputs as TChildOutputs,
						...(changeSet !== undefined ? { changeSet } : {}),
					};
			const workflowChild = workflowChildReplaySnapshot(childName, childResult);
			const outputKeys = Object.keys(outputs);
			await boundary.complete(
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
			await boundary.fail(err);
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

/**
 * Bind a boundary's workspace before its durable start: restore the binding an earlier attempt recorded, or resolve
 * the workspace, then take the writer lease for a writable one. The parent releases the lease when the child settles.
 * When the recorded worktree is not on this machine, this machine lacks the history the binding needs (its repository,
 * branch or step commits, as on another machine), and the run's resume restored the worktree from its snapshots
 * (`restored`, the run's root mappings), the child is bound in that restored worktree instead. A worktree that is here
 * keeps failing closed when its history is gone. The recorded binding itself is never rewritten.
 */
async function bindChildWorkspace(
	workspace: Workspace,
	invocation: DurableChildInvocation,
	signal: AbortSignal,
	owner: string,
	restored: readonly WorktreeRootMapping[],
): Promise<void> {
	const recorded = invocation.recordedWorkspace;
	let binding: BoundWorkspace;
	if (recorded === undefined) binding = await resolveWorkspace(workspace, { signal });
	else {
		try {
			await restoreWorkspace(recorded, {
				signal,
				recreateMissingBranch: !invocation.recordedChildProgress(),
				recordedHeads: invocation.recordedChildHeads(recorded),
			});
			binding = recorded;
		} catch (error) {
			const worktree = mapWorkflowWorktreePath(recorded.worktree, restored);
			if (!isWorkspaceRestoreError(error) || worktree === recorded.worktree || existsSync(recorded.worktree))
				throw error;
			binding = { ...recorded, worktree };
		}
	}
	const lease =
		binding.sandbox === "workspace-write" ? await acquireWorkspaceWriterLease(binding, { owner, signal }) : undefined;
	invocation.bindWorkspace(binding, lease);
}
