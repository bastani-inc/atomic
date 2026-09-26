import type { OverlayOptions } from "@earendil-works/pi-tui";
import { experimentalToolSamplingProperty } from "../../experimental.ts";
import { getHostQuestionnaire } from "../../extensions/host-input.js";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { ExtensionUIContext } from "../../extensions/ui-types.js";
import { loadConfig, validateGuidanceFields } from "./config.ts";
import { QuestionnaireSession } from "./state/questionnaire-session.ts";
import { ROW_INTENT_META, sentinelsToAppend } from "./state/row-intent.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.ts";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";
// Private first-party route: a workflow owns this waiter even without a human host.
const STAGE_QUESTIONNAIRE = Symbol.for("atomic-coding-agent/stage-questionnaire@1");

/**
 * Longest prompt title carried on `ui_prompt_start` for a questionnaire. The
 * title is a label for observers (status reporters, notifications), not the
 * question body, so it is cut with an ellipsis rather than wrapped.
 */
export const QUESTIONNAIRE_PROMPT_TITLE_LIMIT = 120;

/**
 * The first question, bounded, as the questionnaire's prompt title. A
 * questionnaire with several questions still gets one title: observers see a
 * single blocking prompt, and the first question is what the user sees first.
 */
export function questionnairePromptTitle(questions: readonly Pick<QuestionData, "question">[]): string | undefined {
	const first = questions[0]?.question.trim();
	if (first === undefined || first.length === 0) return undefined;
	return first.length <= QUESTIONNAIRE_PROMPT_TITLE_LIMIT
		? first
		: `${first.slice(0, QUESTIONNAIRE_PROMPT_TITLE_LIMIT - 1)}…`;
}

/**
 * Mount options for the blocking questionnaire (#2378).
 *
 * The dialog used to mount inline, inside the fullscreen dock, where it is a
 * flex sibling of the transcript `ScrollView`. A tall side-by-side dialog then
 * took the transcript's rows: on a 40-row terminal the transcript viewport
 * collapsed from 34 rows to 6, and pi-tui derives its page step from that
 * viewport (`viewportHeight - PAGE_SCROLL_OVERLAP`), so PageUp crawled two
 * lines at a time through a six-line window.
 *
 * A bottom-anchored overlay is composited over the bottom rows instead of being
 * measured into the layout, so the transcript keeps its full viewport height
 * and its full page step. `reserveTranscriptRows` is what makes those rows
 * observable rather than merely addressable: the host bounds this overlay so a
 * transcript strip always survives, and extends the transcript's scroll extent
 * by the rows the overlay still covers, so the newest output can be raised into
 * that strip. No `maxHeight` — the host's bound is tighter, and letting pi-tui
 * slice as well would make the measured overlay height wrong.
 */
export const QUESTIONNAIRE_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
};

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	const hasAnyPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	for (const kind of sentinelsToAppend(question, hasAnyPreview)) {
		items.push({ kind, label: ROW_INTENT_META[kind].label });
	}
	return items;
}

export const askUserQuestionToolSystemPromptContribution = Object.freeze({
	snippet: `Ask all user questions through this tool, including clarifications and approvals; up to ${MAX_QUESTIONS} questions with ${MIN_OPTIONS}-${MAX_OPTIONS} options each`,
	guidelines: Object.freeze([
		"When ask_user_question or an equivalent question tool is available, all questions to the user must use that tool instead of plain text, including clarifications, preferences, confirmations, approvals, and permission to proceed. Prefer ask_user_question when available. In these sessions, do not end a progress update or final response with a prose-only question such as 'Proceed?'.",
		"Ask only when a decision is needed; do not seek approval again for already-authorized work. For a confirmation, put the concrete action and its scope in the question and offer explicit proceed and decline options. A cancelled or unanswered question is not approval.",
		`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
		`Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
		"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
		"If ask_user_question is unavailable, use an equivalent available question tool with its supported schema. If no usable question tool is available, continue autonomously using best judgment and state evidence-backed assumptions. Tool unavailability alone is not a blocker; preserve safety and authorization constraints.",
	] as const),
} as const);

export function createAskUserQuestionToolDefinition(options?: {
	readonly chatAsOption?: boolean;
}): ToolDefinition<typeof QuestionParamsSchema, unknown> {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	return {
		name: "ask_user_question",
		concurrency: "exclusive",
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. When ask_user_question or an equivalent question tool is available, all questions to the user must use that tool instead of plain text, including a short 'Proceed?' confirmation. Prefer ask_user_question when available. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Request confirmation, approval, or permission to proceed

Usage notes:
- Ask only for decisions that are needed; do not re-request existing authorization. State the exact action and scope, with explicit proceed and decline options for confirmations. A cancelled or unanswered question is not approval.
- If ask_user_question is unavailable, use an equivalent available question tool with its supported schema. If no usable question tool is available, continue autonomously using best judgment and state evidence-backed assumptions. Tool unavailability alone is not a blocker; preserve safety and authorization constraints.
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
		promptSnippet: guidance.promptSnippet ?? askUserQuestionToolSystemPromptContribution.snippet,
		promptGuidelines: guidance.promptGuidelines ?? [...askUserQuestionToolSystemPromptContribution.guidelines],
		...experimentalToolSamplingProperty(),
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			const stageOwned = (
				ctx.ui as ExtensionUIContext & {
					[STAGE_QUESTIONNAIRE]?: (sessionId: string, ui: ExtensionUIContext) => void;
				}
			)[STAGE_QUESTIONNAIRE];
			if (typeof stageOwned !== "function" && !(ctx.hasHumanInput ?? ctx.hasUI))
				return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			if (typeof stageOwned === "function") {
				stageOwned(ctx.sessionManager.getSessionId(), ctx.ui);
				return buildQuestionnaireResponse(
					await presentQuestionnaire(ctx.ui, typed, signal, options?.chatAsOption),
					typed,
				);
			}
			const questionnaire = getHostQuestionnaire(ctx.ui);
			const result = questionnaire
				? await questionnaire(typed, signal, (requestSignal) =>
						presentQuestionnaire(ctx.ui, typed, requestSignal, options?.chatAsOption),
					)
				: await presentQuestionnaire(ctx.ui, typed, signal, options?.chatAsOption);
			return buildQuestionnaireResponse(result, typed);
		},
	};
}

/** Rendering adapter shared by the CLI bridge and legacy presentation hosts. */
export async function presentQuestionnaire(
	ui: ExtensionUIContext,
	params: QuestionParams,
	signal?: AbortSignal,
	chatAsOption?: boolean,
): Promise<QuestionnaireResult> {
	const itemsByTab = params.questions.map(buildItemsForQuestion);
	ui.setWorkingVisible?.(false);
	try {
		return await ui.custom<QuestionnaireResult>(
			(tui, theme, _kb, done) =>
				new QuestionnaireSession({
					tui,
					theme,
					params,
					itemsByTab,
					done,
					...(chatAsOption === true ? { chatAsOption: true } : {}),
				}).component,
			{
				signal,
				overlay: true,
				reserveTranscriptRows: true,
				overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
				// Lets ui_prompt_start observers say what is being asked; without it
				// they only see that some custom prompt opened.
				title: questionnairePromptTitle(params.questions),
			},
		);
	} finally {
		ui.setWorkingVisible?.(true);
	}
}

export { buildQuestionnaireResponse, buildToolResult };
