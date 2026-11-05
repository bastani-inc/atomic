import type { Api, Model, RetryPolicy } from "@bastani/pi-ai";
import type { DecisionModelSelectionOptions } from "../structured-output/types.js";
import type { JsonObject } from "../tools/structured-output.ts";

/** Pick one option. A classifier answers with every option's probability. */
export interface DecisionChoiceQuestion<TOption extends string = string> {
	readonly type: "choice";
	readonly instructions: string;
	/** Each option and what it means. The keys are the possible answers. */
	readonly criteria: Readonly<Record<TOption, string>>;
}

/** A yes/no question (a Noul). A classifier answers with the probability of yes. */
export interface DecisionBoolQuestion {
	readonly type: "bool";
	readonly instructions: string;
	/** What yes (`true`) and no (`false`) mean. */
	readonly criteria: { readonly true: string; readonly false: string };
}

/** Grade on ordered levels, lowest first. A classifier answers with a score and its confidence. */
export interface DecisionScoreQuestion {
	readonly type: "score";
	readonly instructions: string;
	/** At least two level descriptions; the score is between 0 and the last level's index. */
	readonly criteria: readonly string[];
}

export type DecisionQuestion = DecisionChoiceQuestion | DecisionBoolQuestion | DecisionScoreQuestion;

/** Named, independent questions about one state. IDs are only correlation keys. */
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface DecisionChoiceAnswer<TOption extends string = string> {
	readonly type: "choice";
	readonly choice: TOption;
	/** Each option's probability; present when a classifier answered. */
	readonly probabilities?: Readonly<Partial<Record<TOption, number>>>;
	/** The classifier's confidence in `choice`. */
	readonly confidence?: number;
}

export interface DecisionBoolAnswer {
	readonly type: "bool";
	readonly value: boolean;
	/** The probability of yes (`true`); present when a classifier answered. */
	readonly probability?: number;
}

export interface DecisionScoreAnswer {
	readonly type: "score";
	readonly score: number;
	/** The classifier's confidence in `score`. */
	readonly confidence?: number;
}

export type DecisionAnswerFor<Q extends DecisionQuestion> =
	Q extends DecisionChoiceQuestion<infer TOption>
		? DecisionChoiceAnswer<TOption>
		: Q extends DecisionBoolQuestion
			? DecisionBoolAnswer
			: DecisionScoreAnswer;

export type DecisionAnswers<Q extends DecisionQuestions> = { readonly [K in keyof Q]: DecisionAnswerFor<Q[K]> };

/** `classifier` answers carry probabilities and confidence; `chat` answers carry neither. */
export type DecisionSource = "classifier" | "chat";

export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
	/** The facts the questions are about, as named JSON values. Never include credentials. */
	readonly state: JsonObject;
	readonly questions: Q;
	/** Context shared by every question. */
	readonly instructions?: string;
	/**
	 * Wall-clock limit in milliseconds for the whole decision: every request, retry, repair and fallback. A positive
	 * integer. Default: the `httpIdleTimeoutMs` setting.
	 */
	readonly deadline?: number;
	/** Cancels the decision; it rejects with the signal's reason. */
	readonly signal?: AbortSignal;
	/**
	 * Only a classifier may answer, so every answer carries probabilities. A chat decision model, or a classifier
	 * failure, then rejects instead of falling back to the current chat model.
	 */
	readonly requireProbabilities?: boolean;
	/** Exact provider/model ID that decides instead of the configured `decisionModel`. */
	readonly model?: string;
	/** The session's settings: `decisionModel`, and optionally retry and `httpIdleTimeoutMs`. */
	readonly settings: DecisionModelSelectionOptions["settings"];
	readonly modelRegistry: DecisionModelSelectionOptions["modelRegistry"] &
		Pick<import("../model-registry.ts").ModelRegistry, "streamSimple"> &
		Partial<Pick<import("../model-registry.ts").ModelRegistry, "getProviderAuth" | "containsConfiguredCredential">>;
	/** The current chat model: the decision model when `decisionModel` is empty or `auto`, and the chat fallback. */
	readonly currentModel?: Model<Api>;
	readonly retry?: RetryPolicy;
}

export interface DecisionResult<Q extends DecisionQuestions = DecisionQuestions> {
	readonly answers: DecisionAnswers<Q>;
	readonly source: DecisionSource;
	/** The provider/model ID that answered. */
	readonly model: string;
	/** The model the provider reported. */
	readonly responseModel: string;
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
	/** Present when the classifier failed and the current chat model answered instead. */
	readonly fallback?: { readonly from: string; readonly to: string; readonly reason: string };
}
