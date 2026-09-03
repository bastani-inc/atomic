import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import {
	type DraftValidationError,
	FEEDBACK_REPOSITORY,
	formatIssueBody,
	scrubFeedback,
	type FeedbackDraft,
	type RedactionSummary,
	validateFeedbackDraft,
} from "./src/index.js";

export const FEEDBACK_COMMAND_DESCRIPTION = "Draft a private, reviewable bug report or enhancement request";
export const FEEDBACK_USAGE = "Usage: /feedback <what happened or what you want to change>";

export type FeedbackPrepareDetails =
	| { readonly errors: readonly DraftValidationError[] }
	| {
			readonly repository: typeof FEEDBACK_REPOSITORY;
			readonly kind: FeedbackDraft["kind"];
			readonly title: string;
			readonly body: string;
			readonly privacySummary: readonly RedactionSummary[];
	  };

const feedbackPrepareParameters = Type.Object({
	kind: Type.Union([Type.Literal("bug"), Type.Literal("enhancement")]),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	repro: Type.Optional(Type.String()),
	expected: Type.Optional(Type.String()),
	version: Type.Optional(Type.String()),
	change: Type.Optional(Type.String()),
	why: Type.Optional(Type.String()),
	how: Type.Optional(Type.String()),
});

export default function feedback(pi: ExtensionAPI): void {
	pi.registerCommand("feedback", {
		description: FEEDBACK_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			if (!args.trim()) {
				await pi.sendMessage(
					{ customType: "feedback-usage", content: FEEDBACK_USAGE, display: true },
					{ triggerTurn: false },
				);
				return;
			}
			const candidate = ctx
				.getSkillCatalog?.()
				.candidates.find(
					(item) => item.skill.name === "feedback" && item.skill.sourceInfo.configurationOrigin === "bundled",
				);
			if (!candidate) {
				await pi.sendMessage(
					{ customType: "feedback-error", content: "The bundled feedback skill is unavailable.", display: true },
					{ triggerTurn: false },
				);
				return;
			}
			pi.sendUserMessage(`/skill:${candidate.selector} ${args}`, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
		},
	});

	pi.registerTool<typeof feedbackPrepareParameters, FeedbackPrepareDetails>({
		name: "feedback_prepare_issue",
		label: "Prepare feedback issue",
		description: "Validate, format, and remove private data from a feedback issue draft without posting it.",
		parameters: feedbackPrepareParameters,
		execute: async (_toolCallId, params) => {
			const draft: FeedbackDraft =
				params.kind === "bug"
					? {
							kind: "bug",
							title: params.title,
							description: params.description ?? "",
							repro: params.repro ?? "",
							expected: params.expected,
							version: params.version,
						}
					: {
							kind: "enhancement",
							title: params.title,
							change: params.change ?? "",
							why: params.why ?? "",
							how: params.how,
						};
			const validation = validateFeedbackDraft(draft);
			if (!validation.ok) {
				const details = { errors: validation.errors };
				return { content: [{ type: "text", text: validation.errors.map(({ message }) => message).join("; ") }], details };
			}
			const scrubbed = scrubFeedback(draft.title, formatIssueBody(draft));
			const details = {
				repository: FEEDBACK_REPOSITORY,
				kind: draft.kind,
				title: scrubbed.title,
				body: scrubbed.body,
				privacySummary: scrubbed.replacements,
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}
