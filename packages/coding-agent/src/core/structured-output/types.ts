import type { Api, ClassifierApi, ClassifierModel, Model, RetryPolicy } from "@bastani/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { JsonObject } from "../tools/structured-output.ts";

/** A semantic judgment, not an execution instruction. IDs are only correlation keys. */
export interface StructuredChoiceQuestion {
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string>>;
}

export interface RouterModelSelectionOptions {
	readonly settings: Pick<SettingsManager, "getRouterModel"> & Partial<Pick<SettingsManager, "getRetrySettings">>;
	readonly modelRegistry: Pick<ModelRegistry, "getAll"> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getClassifierModel" | "classify">>;
	/** Read the active chat model at invocation time; never change it to perform a decision. */
	readonly currentModel?: Model<Api>;
}

export type StructuredOutputModel =
	| { readonly kind: "chat"; readonly fullId: string; readonly model: Model<Api> }
	| { readonly kind: "classifier"; readonly fullId: string; readonly model: ClassifierModel<ClassifierApi> };

export interface ModelAttempt {
	readonly model: string;
	readonly skipped?: boolean;
	readonly skipReason?: string;
	readonly error?: string;
}

export interface StructuredOutputRequest<T extends TSchema> {
	readonly model?: string;
	readonly fallbackModels?: readonly string[];
	readonly currentModel?: Model<Api>;
	readonly modelRegistry: Pick<ModelRegistry, "streamSimple" | "getAll"> &
		Partial<Pick<ModelRegistry, "getClassifierModel" | "classify">>;
	/** Supply actual task, facts, constraints and reference text. Never supply credentials. */
	readonly state: JsonObject;
	readonly instructions: string;
	/** The normalized result contract. Use additionalProperties: false on closed objects. */
	readonly schema: T;
	readonly signal?: AbortSignal;
	readonly maxTokens?: number;
	readonly retry?: RetryPolicy;
}

export interface InternalStructuredOutputRequest<T extends TSchema>
	extends Omit<StructuredOutputRequest<T>, "model" | "modelRegistry"> {
	readonly model: StructuredOutputModel;
	readonly modelRegistry: Pick<ModelRegistry, "streamSimple"> &
		Partial<Pick<ModelRegistry, "getProviderAuth" | "getClassifierModel" | "classify">>;
	readonly candidateFallback?: true;
	readonly classifier: {
		/** Independent judgments, packed together where possible. Conditional questions must describe their premise. */
		readonly questions: Readonly<Record<string, StructuredChoiceQuestion>>;
		/** Pure exact lookup/composition only. No inference, execution or authorization here. */
		readonly decode: (choices: Readonly<Record<string, string>>) => Static<T>;
	};
}

/** Shared prerequisite router request. Neither routing consumer is activated by this API alone. */
export interface RouterDecisionRequest<T extends TSchema>
	extends Omit<InternalStructuredOutputRequest<T>, "model" | "modelRegistry" | "currentModel" | "fallbackModels">,
		RouterModelSelectionOptions {
	readonly modelRegistry: Pick<ModelRegistry, "getAll" | "streamSimple"> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getProviderAuth" | "getClassifierModel" | "classify">>;
}

export interface StructuredOutputResult<T> {
	readonly value: T;
	readonly model: string;
	readonly responseModel: string;
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
	readonly fallback?: { readonly from: string; readonly to: string; readonly reason: string };
	readonly modelAttempts?: readonly ModelAttempt[];
}
