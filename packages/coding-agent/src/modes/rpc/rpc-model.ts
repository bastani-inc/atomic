import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import {
	attachProviderModelReference,
	getProviderTransportSelection,
} from "../../core/provider-model-reference.js";

/** JSON-safe RPC projection of a model and its optional provider-owned exact selector. */
export type RpcModel = Model<Api> & { providerSelection?: object };

export function toRpcModel(model: Model<Api>): RpcModel {
	const rpcModel = { ...model } as RpcModel;
	delete rpcModel.providerSelection;
	const providerSelection = getProviderTransportSelection(model);
	if (providerSelection !== undefined) rpcModel.providerSelection = providerSelection;
	return rpcModel;
}

/** Rehydrate exact identity after JSON transport without trusting it as routing metadata. */
export function fromRpcModel(model: RpcModel): Model<Api> {
	const selection = model.providerSelection;
	if (selection === undefined) return model;
	const version = "version" in selection && typeof selection.version === "number"
		? selection.version
		: 1;
	return attachProviderModelReference(model, {
		provider: model.provider,
		schemaVersion: version,
		data: selection,
		transportSelection: selection,
	});
}

type ModelChangedEvent = Extract<AgentSessionEvent, { type: "model_changed" }>;

export type RpcEvent = Exclude<AgentSessionEvent, ModelChangedEvent> |
	(Omit<ModelChangedEvent, "model" | "previousModel"> & {
		model: RpcModel;
		previousModel: RpcModel | undefined;
	});

export function toRpcEvent(event: AgentSessionEvent): RpcEvent {
	if (event.type !== "model_changed") return event;
	return {
		...event,
		model: toRpcModel(event.model),
		previousModel: event.previousModel ? toRpcModel(event.previousModel) : undefined,
	};
}

export function fromRpcScopedModels(
	scopedModels: ReadonlyArray<{ model: RpcModel; thinkingLevel?: ThinkingLevel }>,
): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
	return scopedModels.map(({ model, thinkingLevel }) => ({
		model: fromRpcModel(model),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	}));
}

export function toRpcScopedModels(
	scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
): Array<{ model: RpcModel; thinkingLevel?: ThinkingLevel }> {
	return scopedModels.map(({ model, thinkingLevel }) => ({
		model: toRpcModel(model),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	}));
}
