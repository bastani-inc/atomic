import { type CreateAgentSessionOptions, SessionManager } from "@bastani/atomic";
import type { StageOptions } from "../../shared/types.js";
import type { WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";

interface StageSessionOptionsInput {
	readonly effectiveStageOptions: StageOptions | undefined;
	readonly candidate: WorkflowResolvedModelCandidate | undefined;
	readonly restoreSavedModel?: boolean;
	readonly reattachSessionFile: string | undefined;
	readonly sharedModelRuntime: CreateAgentSessionOptions["modelRuntime"];
}

export function buildStageSessionOptions(input: StageSessionOptionsInput): StageOptions | undefined {
	const options: StageOptions =
		input.candidate === undefined
			? { ...(input.effectiveStageOptions ?? {}) }
			: {
					...(input.effectiveStageOptions ?? {}),
					model: input.candidate.value,
					...(input.candidate.reasoningLevel !== undefined
						? { thinkingLevel: input.candidate.reasoningLevel }
						: {}),
					fallbackModels: undefined,
					fallbackThinkingLevels: undefined,
				};
	if (input.restoreSavedModel === true) delete options.model;

	if (input.reattachSessionFile !== undefined && options.sessionManager === undefined) {
		const cwd = options.cwd ?? process.cwd();
		options.sessionManager = SessionManager.open(input.reattachSessionFile, options.sessionDir, cwd);
		options.context = undefined;
		options.forkFromSessionFile = undefined;
	}
	if (input.sharedModelRuntime !== undefined && options.modelRuntime === undefined) {
		options.modelRuntime = input.sharedModelRuntime;
	}
	return Object.keys(options).length === 0 ? undefined : options;
}
