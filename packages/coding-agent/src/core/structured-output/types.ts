import type { Api, ClassifierAnswer, ClassifierApi, ClassifierModel, Model, RetryPolicy } from "@bastani/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { JsonObject } from "../tools/structured-output.ts";

/** A semantic judgment, not an execution instruction. IDs are only correlation keys. */
export interface StructuredChoiceQuestion {
	readonly type?: "choice";
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string>>;
}

/** A yes/no judgment; the classifier answers with the probability of `true`. */
export interface StructuredBoolQuestion {
	readonly type: "bool";
	readonly instructions: string;
	readonly criteria: { readonly true: string; readonly false: string };
}

/** A graded judgment over ordered levels, lowest first. */
export interface StructuredScoreQuestion {
	readonly type: "score";
	readonly instructions: string;
	readonly criteria: readonly string[];
}

export type StructuredDecisionQuestion = StructuredChoiceQuestion | StructuredBoolQuestion | StructuredScoreQuestion;

export interface DecisionModelSelectionOptions {
	readonly settings: Pick<SettingsManager, "getDecisionModel"> &
		Partial<Pick<SettingsManager, "getRetrySettings" | "getHttpIdleTimeoutMs">>;
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
	/** Exact provider/model ID to try first. Omitted: the configured `decisionModel` when `settings` is given, else the current chat model. */
	readonly model?: string;
	/**
	 * The session's settings. With no explicit `model`, the decision starts on `decisionModel` (a classifier when the
	 * result schema is a finite Choice), then `fallbackModels`, then the current chat model.
	 */
	readonly settings?: Pick<SettingsManager, "getDecisionModel">;
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
	/**
	 * Wall-clock limit in milliseconds for the whole decision: every repair attempt, transport retry and model
	 * candidate together. A positive integer. When omitted, the `structured_output` tool uses its session's
	 * `httpIdleTimeoutMs` setting and any other call uses that setting's default of 10 minutes. A disabled idle
	 * timeout (0) leaves only the largest timer delay, about 24.8 days.
	 */
	readonly timeoutMs?: number;
}

export interface InternalStructuredOutputRequest<T extends TSchema>
	extends Omit<StructuredOutputRequest<T>, "model" | "modelRegistry" | "settings"> {
	readonly model: StructuredOutputModel;
	readonly modelRegistry: Pick<ModelRegistry, "streamSimple"> &
		Partial<Pick<ModelRegistry, "getProviderAuth" | "getClassifierModel" | "classify">>;
	readonly candidateFallback?: true;
	readonly classifier: {
		/** Independent judgments, packed together where possible. Conditional questions must describe their premise. */
		readonly questions: Readonly<Record<string, StructuredDecisionQuestion>>;
		/**
		 * Pure exact lookup/composition only. No inference, execution or authorization here. `choices` holds each
		 * Choice answer's option; `answers` holds every classifier answer with its probabilities.
		 */
		readonly decode: (
			choices: Readonly<Record<string, string>>,
			answers: Readonly<Record<string, ClassifierAnswer>>,
		) => Static<T>;
	};
}

/** A schema-shaped decision on the configured decision model. Neither routing consumer is activated by this API alone. */
export interface DecisionModelRequest<T extends TSchema>
	extends Omit<InternalStructuredOutputRequest<T>, "model" | "modelRegistry" | "currentModel" | "fallbackModels">,
		DecisionModelSelectionOptions {
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
