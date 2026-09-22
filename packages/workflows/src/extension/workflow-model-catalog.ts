import { type CreateAgentSessionOptions, routeExecutionModel } from "@bastani/atomic";
import type { WorkflowModelCatalogPort, WorkflowModelInfo } from "../shared/types.js";
import type { PiModelContext } from "./public-types.js";

export type WorkflowModelContext = PiModelContext & { getRouterModel?: () => string };

/**
 * `currentModel` and `preferredProvider` are the launch-time selection. The
 * registry is read lazily and, when `resolveLiveContext` is supplied, through
 * the newest live host generation, so a run that survives a preserving
 * `/reload` still validates and routes stage models after its launch ctx has
 * gone stale (#3201).
 */
export function workflowModelCatalogFromContext(
	ctx?: WorkflowModelContext,
	resolveLiveContext?: () => WorkflowModelContext | undefined,
): WorkflowModelCatalogPort | undefined {
	if (ctx?.modelRegistry === undefined && ctx?.model === undefined) return undefined;
	const live = (): WorkflowModelContext => resolveLiveContext?.() ?? ctx;
	return {
		routeModel: async (input) => {
			const current = live();
			const registry = current.modelRegistry;
			if (
				!current.getRouterModel ||
				!registry?.getAll ||
				!registry.streamSimple ||
				!registry.containsConfiguredCredential
			) {
				throw new Error("Workflow stage auto routing requires host routing and credential screening support.");
			}
			return routeExecutionModel({
				ctx: {
					model: current.model,
					getRouterModel: () => current.getRouterModel!(),
					modelRegistry: {
						getAvailable: () => registry.getAvailable(),
						getAll: () => registry.getAll!(),
						streamSimple: (...args) => registry.streamSimple!(...args),
						containsConfiguredCredential: (text) => registry.containsConfiguredCredential!(text),
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
			});
		},
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
