import { assertWorkspace, attachCleanupCause, type Workspace, WorkspaceBindingError } from "@bastani/atomic";
import {
	isWorkflowDefinition,
	workflowDefinitionRequirementMessage,
} from "../runs/foreground/executor-child-helpers.js";
import { resolveAndValidateInputs } from "../runs/foreground/executor-inputs.js";
import type {
	WorkflowChildResult,
	WorkflowDefinition,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowRunChildArgs,
} from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	type DurableBoundaryDescriptor,
	type DurableChildInvocation,
	prepareDurableChildInvocation,
	validateDurableChildInvocation,
	validateDurableCompletedBoundary,
} from "./boundary-topology.js";
import { durableChildInvocationFingerprint } from "./child-invocation.js";
import { type DurableCompletedStageCheckpoint, stageCheckpointWithOutput } from "./stage-primitive.js";
import type { DurableStageRunTopology, WorkflowSerializableObject } from "./types.js";
import { isWorkflowChildResult, parseWorkflowChildResult } from "./workflow-child-result.js";

export function createDurableChildWorkflowPrimitive(input: {
	readonly workflowId: string;
	readonly rootWorkflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextReplayKey: (name: string, invocationFingerprint: string) => string;
	readonly recordCachedStage: (
		name: string,
		replayKey: string,
		checkpoint: DurableCompletedStageCheckpoint,
	) => void | Promise<void>;
	readonly runTopology: DurableStageRunTopology;
	/** Publish the validated durable identity consumed by the child runner. */
	readonly setChildDurableInvocation: (invocation: DurableChildInvocation) => void;
	/** Reject live work before allocating or persisting a new boundary. */
	readonly assertLiveWorkAllowed?: () => void;
	readonly workflow: <
		TChildInputs extends WorkflowInputValues,
		TChildOutputs extends WorkflowOutputValues,
		TChildRunInputs extends WorkflowInputValues = TChildInputs,
	>(
		child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
		...args: WorkflowRunChildArgs<TChildRunInputs>
	) => Promise<WorkflowChildResult<TChildOutputs>>;
}) {
	return async <
		TChildInputs extends WorkflowInputValues,
		TChildOutputs extends WorkflowOutputValues,
		TChildRunInputs extends WorkflowInputValues = TChildInputs,
	>(
		child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
		...args: WorkflowRunChildArgs<TChildRunInputs>
	): Promise<WorkflowChildResult<TChildOutputs>> => {
		if (!isWorkflowDefinition(child))
			throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
		const options = args[0] as
			| {
					readonly stageName?: string;
					readonly inputs?: Readonly<Record<string, unknown>>;
					readonly workspace?: Workspace;
			  }
			| undefined;
		const boundaryName = options?.stageName ?? `workflow:${child.normalizedName}`;
		const validatedInputs = resolveAndValidateInputs(
			child.inputs,
			options?.inputs ?? {},
			`child workflow "${child.normalizedName}" (${child.name})`,
		);
		const workspace = options?.workspace;
		if (workspace !== undefined) {
			assertWorkspace(workspace, "workspace");
			assertNoWorktreeInput(child, validatedInputs);
		}
		const invocationFingerprint = durableChildInvocationFingerprint(
			child,
			validatedInputs as WorkflowSerializableObject,
			workspace,
		);
		const replayKey = input.nextReplayKey(boundaryName, invocationFingerprint);
		const descriptor: DurableBoundaryDescriptor = {
			workflowId: input.workflowId,
			rootWorkflowId: input.rootWorkflowId,
			backend: input.backend,
			replayKey,
			boundaryName,
			alias: child.normalizedName,
			workflow: child.normalizedName,
			childRunName: child.name,
			invocationFingerprint,
			runTopology: input.runTopology,
		};
		const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey, isWorkflowChildResult);
		const cachedResult = parseWorkflowChildResult(cached?.output);
		if (cached !== undefined && cachedResult !== undefined) {
			validateDurableCompletedBoundary({ ...descriptor, checkpoint: cached, output: cachedResult });
			const recorded = input.recordCachedStage(boundaryName, replayKey, cached);
			// A pooled root keeps a resumed child's checkpoints in memory only until its boundary has read them (#4318).
			input.backend.releaseCheckpointScope?.(input.workflowId, replayKey);
			await recorded;
			return cachedResult as WorkflowChildResult<TChildOutputs>;
		}
		validateDurableChildInvocation(descriptor);
		input.assertLiveWorkAllowed?.();
		// Resolve durable ownership before either UUID can be allocated. A new
		// invocation publishes an identity whose start record is awaited by the
		// inner runner before child code is dispatched.
		const invocation = prepareDurableChildInvocation(descriptor);
		input.setChildDurableInvocation(invocation);
		input.backend.releaseCheckpointScope?.(input.workflowId, replayKey);
		const running = input.workflow(child, {
			...(options ?? {}),
			inputs: validatedInputs,
		} as never) as Promise<WorkflowChildResult<TChildOutputs>>;
		// An unbound child settles exactly as before, without the lease wrapper's extra turns.
		return workspace === undefined ? await running : releasingWorkspaceLease(invocation, running);
	};
}

/** Release a bound child's writer lease once it settles; a release failure never replaces the child's own failure. */
async function releasingWorkspaceLease<T>(invocation: DurableChildInvocation, running: Promise<T>): Promise<T> {
	let result: T;
	try {
		result = await running;
	} catch (error) {
		const cleanupCause = await invocation.workspaceLease?.release().then(
			() => undefined,
			(cause: unknown) => cause,
		);
		throw attachCleanupCause(error, cleanupCause);
	}
	await invocation.workspaceLease?.release();
	return result;
}

/** A declared `worktreeFromInputs` input or a `git_worktree_dir` input selects a worktree the workspace already binds. */
function assertNoWorktreeInput(
	child: Pick<WorkflowDefinition, "name" | "inputBindings">,
	inputs: Readonly<Record<string, unknown>>,
): void {
	for (const name of new Set([
		"git_worktree_dir",
		child.inputBindings?.worktree?.gitWorktreeDir ?? "git_worktree_dir",
	])) {
		const value = inputs[name];
		if (typeof value === "string" && value.trim().length > 0)
			throw new WorkspaceBindingError({
				code: "conflicting-worktree-input",
				fields: { input: name, workflow: child.name },
			});
	}
}
