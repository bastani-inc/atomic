import {
	type CreateAgentSessionOptions,
	DecisionModelUnavailableError,
	decide,
	type ModelRoutingSettings,
	routeExecutionModel,
} from "@bastani/atomic";
import type { RunJournalSettings } from "../durable/journal/resolution.js";
import type { WorkflowModelCatalogPort, WorkflowModelInfo } from "../shared/types.js";
import type { PiModelContext } from "./public-types.js";

export type WorkflowModelContext = PiModelContext & {
	getDecisionModel?: () => string;
	getModelRouting?: () => ModelRoutingSettings;
	getHttpIdleTimeoutMs?: () => number;
};

/** `workflows.autoAdvanceAfterSteer`; the array form of `workflows` and an unset value keep the default, true. */
export function autoAdvanceAfterSteerSetting(settings: RunJournalSettings | undefined): boolean {
	const workflows = settings?.workflows;
	if (workflows === undefined || Array.isArray(workflows)) return true;
	return workflows.autoAdvanceAfterSteer !== false;
}

/**
 * `currentModel` and `preferredProvider` are the launch-time selection. The
 * registry is read lazily and, when `resolveLiveContext` is supplied, through
 * the newest live host generation, so a run that survives a preserving
 * `/reload` still validates and routes stage models after its launch ctx has
 * gone stale (#3201). `readSettings` returns the host's live settings.
 */
export function workflowModelCatalogFromContext(
	ctx?: WorkflowModelContext,
	resolveLiveContext?: () => WorkflowModelContext | undefined,
	readSettings?: () => RunJournalSettings | undefined,
): WorkflowModelCatalogPort | undefined {
	if (ctx?.modelRegistry === undefined && ctx?.model === undefined) return undefined;
	const live = (): WorkflowModelContext => resolveLiveContext?.() ?? ctx;
	return {
		routeModel: async (input) => {
			const current = live();
			const registry = current.modelRegistry;
			if (
				!current.getDecisionModel ||
				!registry?.getAll ||
				!registry.streamSimple ||
				!registry.containsConfiguredCredential ||
				!registry.getClassifierModel
			) {
				throw new Error(
					"Workflow stage auto routing requires host routing, classifier model, and credential screening support.",
				);
			}
			return routeExecutionModel({
				ctx: {
					model: current.model,
					getDecisionModel: () => current.getDecisionModel!(),
					...(current.getModelRouting ? { getModelRouting: () => current.getModelRouting!() } : {}),
					...(current.getHttpIdleTimeoutMs ? { getHttpIdleTimeoutMs: () => current.getHttpIdleTimeoutMs!() } : {}),
					modelRegistry: {
						getAvailable: () => registry.getAvailable(),
						getAll: () => registry.getAll!(),
						streamSimple: (...args) => registry.streamSimple!(...args),
						containsConfiguredCredential: (text) => registry.containsConfiguredCredential!(text),
						getClassifierModel: (provider, modelId) => registry.getClassifierModel!(provider, modelId),
						...(registry.classify ? { classify: registry.classify.bind(registry) } : {}),
						...(registry.getProviderAuth ? { getProviderAuth: registry.getProviderAuth.bind(registry) } : {}),
						...(registry.getProviderAuthStatus
							? { getProviderAuthStatus: registry.getProviderAuthStatus.bind(registry) }
							: {}),
					},
				},
				task: input.task,
				agent: { name: input.stageName, description: "Workflow stage" },
				constraints: input.constraints,
				signal: input.signal,
				selection: input.selection,
				...(input.taskNeeds ? { taskNeeds: input.taskNeeds } : {}),
				...(input.overrideProviderSettings ? { overrideProviderSettings: true } : {}),
				...(input.inference ? { inference: input.inference } : {}),
				...(input.parallelSlot ? { parallelSlot: input.parallelSlot } : {}),
			});
		},
		...(ctx?.getDecisionModel === undefined
			? {}
			: {
					decide: async (request) => {
						const current = live();
						const registry = current.modelRegistry;
						if (!current.getDecisionModel || !registry?.getAll || !registry.streamSimple) {
							throw new DecisionModelUnavailableError({ reason: "host-unsupported" });
						}
						return decide({
							...request,
							settings: {
								getDecisionModel: () => current.getDecisionModel!(),
								getHttpIdleTimeoutMs: current.getHttpIdleTimeoutMs,
							},
							modelRegistry: {
								getAll: () => registry.getAll!(),
								streamSimple: (...args) => registry.streamSimple!(...args),
								getClassifierModel: registry.getClassifierModel?.bind(registry),
								classify: registry.classify?.bind(registry),
								containsConfiguredCredential: registry.containsConfiguredCredential?.bind(registry),
							},
							currentModel: current.model as NonNullable<CreateAgentSessionOptions["model"]> | undefined,
						});
					},
					autoAdvanceAfterSteer: () => autoAdvanceAfterSteerSetting(readSettings?.()),
				}),
		listModels: async (): Promise<readonly WorkflowModelInfo[]> => {
			const current = live();
			const available =
				current.modelRegistry?.getAvailable() ?? (current.model === undefined ? [] : [current.model]);
			return available.map((model) => ({
				provider: String(model.provider),
				id: model.id,
				fullId: `${String(model.provider)}/${model.id}`,
				model: model as NonNullable<CreateAgentSessionOptions["model"]>,
			}));
		},
		...(ctx.model !== undefined
			? {
					currentModel: ctx.model as NonNullable<CreateAgentSessionOptions["model"]>,
					preferredProvider: String(ctx.model.provider),
				}
			: {}),
	};
}
