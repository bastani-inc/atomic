import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, type ThinkingLevel } from "../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import type { ChainClarifyState } from "./chain-clarify-state.ts";
import type { BehaviorOverride } from "./chain-clarify-types.ts";

export function getEffectiveBehavior(state: ChainClarifyState, stepIndex: number): ResolvedStepBehavior {
	const base = state.resolvedBehaviors[stepIndex]!;
	const override = state.behaviorOverrides.get(stepIndex);
	if (!override) return base;

	return {
		output: override.output !== undefined ? override.output : base.output,
		outputMode: base.outputMode,
		reads: override.reads !== undefined ? override.reads : base.reads,
		progress: override.progress !== undefined ? override.progress : base.progress,
		skills: override.skills !== undefined ? override.skills : base.skills,
		model: override.model !== undefined ? override.model : base.model,
	};
}

export function resolveModelFullId(state: ChainClarifyState, modelName: string): string {
	return resolveModelCandidate(modelName, state.availableModels, state.preferredProvider) ?? modelName;
}

export function getEffectiveModel(state: ChainClarifyState, stepIndex: number): string {
	const override = state.behaviorOverrides.get(stepIndex);
	if (override?.model) return resolveModelFullId(state, override.model);

	const baseModel = state.resolvedBehaviors[stepIndex]?.model;
	if (baseModel) return resolveModelFullId(state, baseModel);
	return "default";
}

export function updateBehavior<K extends keyof BehaviorOverride>(
	state: ChainClarifyState,
	stepIndex: number,
	field: K,
	value: Exclude<BehaviorOverride[K], undefined>,
): void {
	const existing = state.behaviorOverrides.get(stepIndex) ?? {};
	state.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
}

export function getAvailableThinkingLevels(state: ChainClarifyState, stepIndex: number): ThinkingLevel[] {
	const model = findModelInfo(getEffectiveModel(state, stepIndex), state.availableModels, state.preferredProvider);
	return getSupportedThinkingLevels(model);
}

export function applyThinkingLevel(state: ChainClarifyState, stepIndex: number, level: ThinkingLevel): void {
	const currentModel = getEffectiveBehavior(state, stepIndex).model;
	if (!currentModel) return;

	const { baseModel } = splitKnownThinkingSuffix(currentModel);
	const newModel = level === "off" ? baseModel : `${baseModel}:${level}`;
	updateBehavior(state, stepIndex, "model", newModel);
}

export function propagateOutputChange(state: ChainClarifyState, changedStepIndex: number, oldOutput: string, newOutput: string): void {
	for (let i = changedStepIndex + 1; i < state.agentConfigs.length; i++) {
		const behavior = getEffectiveBehavior(state, i);

		if (behavior.reads === false || !behavior.reads || behavior.reads.length === 0) {
			continue;
		}

		const readsArray = behavior.reads;
		const oldIndex = readsArray.indexOf(oldOutput);
		if (oldIndex !== -1) {
			const newReads = [...readsArray];
			newReads[oldIndex] = newOutput;
			updateBehavior(state, i, "reads", newReads);
		}
	}
}
