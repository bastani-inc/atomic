import type { OverlayOptions } from "@earendil-works/pi-tui";
import { experimentalToolSamplingProperty } from "../../experimental.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
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
} from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

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

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
	`Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function createAskUserQuestionToolDefinition(): ToolDefinition<typeof QuestionParamsSchema, unknown> {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	return {
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
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
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		...experimentalToolSamplingProperty(),
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			// Suspend the animated working loader for the lifetime of the blocking dialog.
			//
			// The loader ticks every ~88ms and calls `requestRender()` on each frame, and it
			// conveys nothing while we are blocked on human input. Hiding it for the duration
			// keeps the frame behind the dialog static and avoids the differential renderer
			// falling back to a full clear+replay (`\x1b[2J\x1b[H\x1b[3J`) on every tick.
			// Restored once the dialog closes (on every path).
			//
			// Guarded: some hosts (e.g. the workflow stage-UI broker) pass a minimal UI
			// context that only implements `custom`, so treat a missing loader control as a
			// no-op rather than throwing.
			ctx.ui.setWorkingVisible?.(false);
			try {
				const result = await ctx.ui.custom<QuestionnaireResult>(
					(tui, theme, _kb, done) => {
						const session = new QuestionnaireSession({
							tui,
							theme,
							params: typed,
							itemsByTab,
							done,
						});
						return session.component;
					},
					{
						signal,
						overlay: true,
						reserveTranscriptRows: true,
						overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
					},
				);

				return buildQuestionnaireResponse(result, typed);
			} finally {
				ctx.ui.setWorkingVisible?.(true);
			}
		},
	};
}

export { buildQuestionnaireResponse, buildToolResult };
