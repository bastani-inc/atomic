import { type Static, Type } from "typebox";
import { LABELS_BY_KIND, ROW_INTENT_META } from "../state/row-intent.ts";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`) — single source of
 * truth. Adding a new sentinel requires extending the `WrappingSelectItem`
 * union AND adding an entry to `ROW_INTENT_META`; this map then auto-extends.
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels reserved for Pi-internal sentinels — authoring an option with any
 * of these labels triggers the `reserved_label` runtime guard. Three of the
 * four come from `ROW_INTENT_META` (the runtime kinds); `"Other"` is
 * reserved for CC parity only (the model is conditioned to reach for
 * "Other" in CC; we reject it so the runtime sentinel is the single source
 * of truth) and has no runtime kind.
 *
 * Reserved unconditionally — multiSelect questions also reject these labels
 * even though the runtime sentinel is suppressed there.
 *
 * Order is pinned by `types.test.ts:292` — keep the explicit
 * `["Other", other, chat, next]` literal so consumers using
 * `RESERVED_LABELS[i]` indexing or `Set` membership see no behavior change.
 */
export const RESERVED_LABELS = [
	"Other",
	ROW_INTENT_META.other.label,
	ROW_INTENT_META.chat.label,
	ROW_INTENT_META.next.label,
] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "Questions to ask the user (1-4 questions)",
});

export const QuestionParamsSchema = Type.Object({
	questions: QuestionsSchema,
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * Answer-intent discriminated union. `kind` is the single discriminator —
 * pre-1.0.3 boolean flags have been removed (see `banned-flags.test.ts`).
 * Mirrors the row-side `WrappingSelectItem.kind` vocabulary where possible;
 * `multi` is the multi-select variant (no row-side analog).
 *
 * Variant semantics:
 * - `option`: user picked one of the author-defined options. `answer` is the option's label.
 * - `custom`: user typed free-text via the "Type something." row. `answer` is the typed text or null.
 * - `chat`: user picked the chat sentinel. `answer` is either typed inline chat text or the legacy
 *   literal "Chat about this" when submitted empty / whitespace-only.
 * - `multi`: user committed multi-select choices. `selected` carries chosen labels; `answer` is null.
 */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	/**
	 * Markdown text from the matched option's `preview` field, populated only
	 * when the user lands on a single-select option carrying a `preview`.
	 * Used by `buildQuestionnaireResponse` to echo `selected preview: <preview>`
	 * into the LLM-facing envelope. Undefined for multi-select, custom-text
	 * (`kind: "custom"`), and chat (`kind: "chat"`) answers.
	 */
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
