import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { WorkflowModelCatalogPort, WorkflowModelInfo } from "../shared/types.js";
import type { PiModelContext } from "./public-types.js";

export function workflowModelCatalogFromContext(ctx?: PiModelContext): WorkflowModelCatalogPort | undefined {
	if (ctx?.modelRegistry === undefined && ctx?.model === undefined) return undefined;
	return {
		listModels: async (): Promise<readonly WorkflowModelInfo[]> => {
			const available = ctx.modelRegistry?.getAvailable() ?? (ctx.model === undefined ? [] : [ctx.model]);
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
