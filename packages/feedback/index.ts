import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import {
	collectFeedbackDiagnostics,
	type FeedbackDiagnostics,
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
	extensions: Type.Optional(Type.String()),
	isolation: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.String()),
	unknowns: Type.Optional(Type.String()),
	debuggerPaths: Type.Optional(Type.String()),
	change: Type.Optional(Type.String()),
	why: Type.Optional(Type.String()),
	how: Type.Optional(Type.String()),
});

const feedbackDiagnosticsParameters = Type.Object({
	report: Type.String(),
	phase: Type.Union([Type.Literal("before"), Type.Literal("after")]),
	since: Type.Optional(Type.String()),
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

	pi.registerTool<typeof feedbackDiagnosticsParameters, FeedbackDiagnostics>({
		name: "feedback_collect_diagnostics",
		label: "Collect feedback diagnostics",
		description: "Collect a bounded, privacy-scrubbed diagnostic snapshot without modifying the worktree.",
		parameters: feedbackDiagnosticsParameters,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const details = await collectFeedbackDiagnostics(params, {
				ctx,
				loadedExtensions: pi.getLoadedExtensions?.() ?? [],
				exec: (command, args, options) => pi.exec(command, args, { ...options, signal }),
			});
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
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
							extensions: params.extensions,
							isolation: params.isolation?.trim() ? params.isolation : "Not tested without extensions",
							evidence: params.evidence,
							unknowns: params.unknowns,
							debuggerPaths: params.debuggerPaths,
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
				throw new Error(validation.errors.map(({ message }) => message).join("; "));
			}
			const scrubbed = scrubFeedback(draft.title, formatIssueBody(draft));
			const details = {
				repository: FEEDBACK_REPOSITORY,
				kind: draft.kind,
				title: scrubbed.title,
				body: scrubbed.body,
				privacySummary: scrubbed.replacements,
			};
			const privacyNote = scrubbed.replacements.length
				? `Privacy scrubbed: ${scrubbed.replacements.map(({ category, count }) => `${category} (${count})`).join(", ")}.`
				: "Privacy scrubbed: no replacements needed.";
			return { content: [{ type: "text", text: `${details.title}\n\n${details.body}\n\n${privacyNote}` }], details };
		},
	});
}
