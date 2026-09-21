import type { Api, Model } from "@bastani/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { JsonObject } from "../tools/structured-output.ts";

/** A semantic judgment, not an execution instruction. IDs are only correlation keys. */
export interface StructuredChoiceQuestion {
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string>>;
	/** Optional original option key kept available in the final Jev comparison, even if eliminated. */
	readonly retainForFinal?: string;
}

export interface RouterModelSelectionOptions {
	readonly settings: Pick<SettingsManager, "getRouterModel">;
	readonly modelRegistry: Pick<ModelRegistry, "getAll"> & Partial<Pick<ModelRegistry, "getProviderAuthStatus">>;
	/** Read the active chat model at invocation time; never change it to perform a decision. */
	readonly currentModel?: Model<Api>;
}

export type StructuredOutputModel =
	| { readonly kind: "chat"; readonly fullId: string; readonly model: Model<Api> }
	| { readonly kind: "jev"; readonly fullId: "typesafe-ai/jev-latest" | "openrouter/~typesafe/jev-latest" };

export interface StructuredOutputRequest<T extends TSchema> {
	/** Explicit inference model. General structured output never reads routerModel or the chat selection. */
	readonly model: StructuredOutputModel;
	/** Full registries resolve Jev through normal provider auth; minimal adapters retain environment-only support. */
	readonly modelRegistry: Pick<ModelRegistry, "streamSimple"> & Partial<Pick<ModelRegistry, "getProviderAuth">>;
	/** Supply actual task, facts, constraints and reference text. Never supply credentials. */
	readonly state: JsonObject;
	readonly instructions: string;
	/** The normalized result contract. Use additionalProperties: false on closed objects. */
	readonly schema: T;
	readonly jev: {
		/** Independent judgments, packed together where possible. Conditional questions must describe their premise. */
		readonly questions: Readonly<Record<string, StructuredChoiceQuestion>>;
		/** Pure exact lookup/composition only. No inference, execution or authorization here. */
		readonly decode: (choices: Readonly<Record<string, string>>) => Static<T>;
	};
	readonly signal?: AbortSignal;
	/** Ordinary-provider output bound, default 4096 tokens. */
	readonly maxTokens?: number;
}

/** Shared prerequisite router request. Neither routing consumer is activated by this API alone. */
export interface RouterDecisionRequest<T extends TSchema>
	extends Omit<StructuredOutputRequest<T>, "model" | "modelRegistry">,
		RouterModelSelectionOptions {
	readonly modelRegistry: Pick<ModelRegistry, "getAll" | "streamSimple"> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getProviderAuth">>;
}

export interface StructuredOutputResult<T> {
	readonly value: T;
	readonly model: string;
	readonly responseModel: string;
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
	/** Present when default Jev routing failed and the current chat model supplied the validated result. */
	readonly fallback?: { readonly from: string; readonly to: string; readonly reason: string };
}
