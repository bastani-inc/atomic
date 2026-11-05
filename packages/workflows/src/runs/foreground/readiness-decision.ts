import {
	type DecisionBoolQuestion,
	type DecisionChoiceQuestion,
	type DecisionResult,
	findDecisionError,
	isDecisionModelUnavailableError,
} from "@bastani/atomic";

/**
 * Per-action probability thresholds for readiness after a steer. Advancing completes the stage and cannot be undone,
 * so it needs both a confident `advance` and a confident yes from the companion question. Staying open only waits
 * for the user's next message, so it needs less. Anything else asks the user.
 */
export const READINESS_DECISION_THRESHOLDS: ReadinessDecisionThresholds = Object.freeze({
	/** Advance only when P(advance) is at least this... */
	advance: 0.85,
	/** ...and P(the reply fully addresses the user's message) is at least this. */
	addressed: 0.8,
	/** Keep the stage open without asking when P(stay) is at least this. */
	stay: 0.7,
});

export interface ReadinessDecisionThresholds {
	readonly advance: number;
	readonly addressed: number;
	readonly stay: number;
}

/** The longest text of each state field the decision model receives. */
export const READINESS_STATE_MAX_CHARS = 4_000;

export const READINESS_DECISION_INSTRUCTIONS =
	"A workflow stage asked the user a question. The user then sent `user_message`, and the stage answered with `stage_reply`. `stage_objective` is what the stage was asked to do. Decide whether the stage can complete now or should stay open for the user.";

export const READINESS_DECISION_QUESTIONS = Object.freeze({
	next_action: Object.freeze({
		type: "choice",
		instructions: "Should the workflow move on to its next stage now, or keep this stage open for the user?",
		criteria: Object.freeze({
			advance:
				"The user's message was a complete answer or approval, the stage's reply acted on it, and the stage's objective needs nothing more from the user.",
			stay: "The user asked for more work, raised a new question or concern, or the stage's reply leaves something open for the user.",
		}),
	}),
	reply_addresses_message: Object.freeze({
		type: "bool",
		instructions:
			"Does the stage's reply fully address the user's message and leave nothing the user still needs to answer?",
		criteria: Object.freeze({
			true: "Yes. The reply handles the whole message, and the user has nothing left to answer.",
			false: "No. Part of the message is unhandled, or the reply asks the user something.",
		}),
	}),
}) satisfies {
	readonly next_action: DecisionChoiceQuestion<"advance" | "stay">;
	readonly reply_addresses_message: DecisionBoolQuestion;
};

export type ReadinessDecisionQuestions = typeof READINESS_DECISION_QUESTIONS;

/** `advance`: complete the stage. `stay`: keep it open and wait. `ask`: ask "Are you ready to move on to the next stage?". */
export type ReadinessOutcome = "advance" | "stay" | "ask";

export interface ReadinessProbabilities {
	readonly advance: number;
	readonly stay: number;
	/** P(yes) of the companion question "does the reply fully address the user's message". */
	readonly addressed: number;
}

export interface ReadinessVerdict {
	readonly outcome: ReadinessOutcome;
	/** Absent when the decision carried no probabilities, which always asks. */
	readonly probabilities?: ReadinessProbabilities;
}

/** Apply the thresholds in code. Answers without probabilities (a chat model's) always ask. */
export function readinessVerdict(
	result: Pick<DecisionResult<ReadinessDecisionQuestions>, "answers">,
	thresholds: ReadinessDecisionThresholds = READINESS_DECISION_THRESHOLDS,
): ReadinessVerdict {
	const { next_action: action, reply_addresses_message: addressed } = result.answers;
	const advance = action.probabilities?.advance;
	const stay = action.probabilities?.stay;
	if (advance === undefined || stay === undefined || addressed.probability === undefined) return { outcome: "ask" };
	const probabilities = { advance, stay, addressed: addressed.probability };
	if (advance >= thresholds.advance && probabilities.addressed >= thresholds.addressed)
		return { outcome: "advance", probabilities };
	if (stay >= thresholds.stay) return { outcome: "stay", probabilities };
	return { outcome: "ask", probabilities };
}

/** What happened to a stage's readiness after a steer, recorded on the stage. */
export interface StageReadinessDecision {
	/** `advanced`/`stayed`: the decision model decided. `asked`: the user was asked "Are you ready to move on?". */
	readonly outcome: "advanced" | "stayed" | "asked";
	readonly at: number;
	/** The provider/model ID that decided, when it answered. */
	readonly model?: string;
	readonly probabilities?: ReadinessProbabilities;
	/** The typed error that made the question fall back, when the decision failed. */
	readonly error?: { readonly name: string; readonly code: string };
}

const OUTCOME_RECORD: Readonly<Record<ReadinessOutcome, StageReadinessDecision["outcome"]>> = {
	advance: "advanced",
	stay: "stayed",
	ask: "asked",
};

export function readinessDecisionRecord(
	verdict: ReadinessVerdict,
	model: string,
	at: number = Date.now(),
): StageReadinessDecision {
	return Object.freeze({
		outcome: OUTCOME_RECORD[verdict.outcome],
		at,
		model,
		...(verdict.probabilities === undefined ? {} : { probabilities: Object.freeze({ ...verdict.probabilities }) }),
	});
}

/**
 * True when the decision model is a chat model, whose answers carry no probabilities. Readiness cannot be decided
 * then, which is expected rather than a failure: the user is asked as before and nothing is recorded.
 */
export function decisionModelGivesNoProbabilities(error: unknown): boolean {
	const typed = findDecisionError(error);
	return isDecisionModelUnavailableError(typed) && typed.reason === "no-probabilities";
}

/** The fallback record of a failed decision: the question is asked and the typed error is kept. */
export function readinessFailureRecord(error: unknown, at: number = Date.now()): StageReadinessDecision {
	const typed = findDecisionError(error);
	const named = error instanceof Error ? error : undefined;
	return Object.freeze({
		outcome: "asked",
		at,
		error: Object.freeze({
			name: typed?.name ?? named?.name ?? "Error",
			code: typed?.code ?? "unknown",
		}),
	});
}

function percent(value: number): string {
	return value.toFixed(2);
}

/** One line for status and the stage transcript, for example "Decision model advanced the stage (p=0.93)". */
export function describeReadinessDecision(decision: StageReadinessDecision): string {
	const p = decision.probabilities;
	if (decision.outcome === "advanced")
		return `Decision model advanced the stage (p=${percent(p?.advance ?? 0)}, addressed p=${percent(p?.addressed ?? 0)})`;
	if (decision.outcome === "stayed") return `Decision model kept the stage open (p=${percent(p?.stay ?? 0)})`;
	if (decision.error !== undefined) return `Decision model failed (${decision.error.code}); asked whether to move on`;
	return p === undefined
		? "Decision model was unsure; asked whether to move on"
		: `Decision model was unsure (advance p=${percent(p.advance)}, stay p=${percent(p.stay)}, addressed p=${percent(p.addressed)}); asked whether to move on`;
}

function truncated(text: string): string {
	return text.length <= READINESS_STATE_MAX_CHARS ? text : `${text.slice(0, READINESS_STATE_MAX_CHARS)}…`;
}

/** The state the decision model reads: the stage objective, the user's message and the stage's reply, truncated. */
export function readinessState(input: {
	readonly objective: string | undefined;
	readonly userMessage: string;
	readonly reply: string | undefined;
}): { stage_objective: string; user_message: string; stage_reply: string } {
	return {
		stage_objective: truncated(input.objective ?? ""),
		user_message: truncated(input.userMessage),
		stage_reply: truncated(input.reply ?? ""),
	};
}
