import { type ExtensionContext, resolveAutoModel, type Settings } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.js";
import { THINKING_LEVELS } from "../../shared/model-info.js";
import { filterModelsByScope, isModelCandidateAllowed, type ResolvedModelScope } from "./model-scope.js";

/**
 * The `provider/model:effort` a `model: "auto"` launch runs: the user's default model at the agent's own thinking
 * level or the default one, else the launching session's model and thinking level. No model is asked. Undefined when
 * neither exists, so the launch runs the parent's model as one that names none does.
 */
export function resolveSubagentAutoModel(
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">,
	settings: Settings | undefined,
	agent: Pick<AgentConfig, "thinking">,
	scope?: ResolvedModelScope,
): string | undefined {
	const effort = THINKING_LEVELS.find((level) => level === agent.thinking);
	const availableModels = filterModelsByScope(ctx.modelRegistry.getAvailable(), scope);
	const sessionModel =
		ctx.model !== undefined &&
		(scope === undefined || isModelCandidateAllowed(`${ctx.model.provider}/${ctx.model.id}`, scope.allowedFullIds))
			? ctx.model
			: undefined;
	const selected = resolveAutoModel({
		settings,
		availableModels,
		sessionModel,
		sessionThinkingLevel: ctx.thinkingLevel,
		...(effort === undefined ? {} : { thinkingLevel: effort }),
	});
	return selected && `${selected.model.provider}/${selected.model.id}:${selected.thinkingLevel}`;
}
