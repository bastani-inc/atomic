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
	DurableNestedTopologyError,
	prepareDurableChildInvocation,
	validateDurableChildInvocation,
	validateDurableCompletedBoundary,
} from "./boundary-topology.js";
import { durableChildInvocationFingerprint } from "./child-invocation.js";
import { type DurableCompletedStageCheckpoint, stageCheckpointWithOutput } from "./stage-primitive.js";
import type { DurableCheckpoint, DurableStageRunTopology, WorkflowSerializableObject } from "./types.js";
import { isWorkflowChildResult, parseWorkflowChildResult } from "./workflow-child-result.js";

export function createDurableChildWorkflowPrimitive(input: {
	readonly workflowId: string;
	readonly rootWorkflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextReplayKey: (name: string, invocationFingerprint: string) => string;
	readonly recordCachedStage: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint) => void;
	readonly runTopology: DurableStageRunTopology;
	/** Publish the validated durable identity consumed by the child runner. */
	readonly setChildDurableInvocation: (invocation: DurableChildInvocation) => void;
	readonly workflow: <
		TChildInputs extends WorkflowInputValues,
		TChildOutputs extends WorkflowOutputValues,
		TChildRunInputs extends WorkflowInputValues = TChildInputs,
	>(
		child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
		...args: WorkflowRunChildArgs<TChildRunInputs>
	) => Promise<WorkflowChildResult<TChildOutputs>>;
}) {
	const legacyReplayCounts = new Map<string, number>();
	const nextLegacyReplayKey = (name: string): string => {
		const next = (legacyReplayCounts.get(name) ?? 0) + 1;
		legacyReplayCounts.set(name, next);
		return `workflow:${name}:${next}`;
	};
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
			  }
			| undefined;
		const boundaryName = options?.stageName ?? `workflow:${child.normalizedName}`;
		const validatedInputs = resolveAndValidateInputs(
			child.inputs,
			options?.inputs ?? {},
			`child workflow "${child.normalizedName}" (${child.name})`,
		);
		const invocationFingerprint = durableChildInvocationFingerprint(
			child,
			validatedInputs as WorkflowSerializableObject,
		);
		const newReplayKey = input.nextReplayKey(boundaryName, invocationFingerprint);
		const legacyReplayKey = nextLegacyReplayKey(boundaryName);
		const checkpoints = input.backend.listCheckpoints(input.workflowId);
		const hasNew = hasInvocationData(checkpoints, newReplayKey);
		const hasLegacy = hasInvocationData(checkpoints, legacyReplayKey);
		if (hasNew && hasLegacy) {
			throw new DurableNestedTopologyError(`new and legacy invocation scopes conflict at ${newReplayKey}`);
		}
		const replayKey = hasNew ? newReplayKey : hasLegacy ? legacyReplayKey : newReplayKey;
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
			input.recordCachedStage(boundaryName, replayKey, cached);
			return cachedResult as WorkflowChildResult<TChildOutputs>;
		}
		validateDurableChildInvocation(descriptor);
		// Resolve durable ownership before either UUID can be allocated. A new
		// invocation publishes an identity whose start record is awaited by the
		// inner runner before child code is dispatched.
		input.setChildDurableInvocation(prepareDurableChildInvocation(descriptor));
		return (await input.workflow(child, {
			...(options ?? {}),
			inputs: validatedInputs,
		} as never)) as WorkflowChildResult<TChildOutputs>;
	};
}

function hasInvocationData(checkpoints: readonly DurableCheckpoint[], replayKey: string): boolean {
	const prefix = `${replayKey}:`;
	return checkpoints.some((checkpoint) =>
		checkpoint.kind === "stage"
			? checkpoint.replayKey === replayKey || checkpoint.replayKey.startsWith(prefix)
			: checkpoint.checkpointId.startsWith(prefix),
	);
}
