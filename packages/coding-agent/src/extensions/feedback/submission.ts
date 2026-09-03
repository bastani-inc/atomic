import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../core/extensions/index.js";
import { StringEnum } from "../../core/typebox-compat.js";
import type { FeedbackInvestigationAssessment, FeedbackInvestigationController } from "./investigation.js";
import {
	type FeedbackFailureAction,
	FeedbackFailureComponent,
	type FeedbackPostHandler,
	type FeedbackPreviewAction,
	FeedbackPreviewComponent,
	FeedbackSubmissionController,
	FeedbackSubmissionTransitionError,
	formatFeedbackDraftForCopy,
} from "./preview.js";
import { type FeedbackPrivacyReplacement, type ScrubbedFeedbackDraft, scrubFeedbackDraft } from "./privacy.js";
import {
	type ExtensionFreeReproduction,
	type FeedbackDraft,
	type FeedbackKind,
	type FormattedFeedbackDraft,
	formatFeedbackDraft,
} from "./templates.js";
import { formatWorkingTreeDisclosure } from "./working-tree.js";

const FeedbackSubmissionParameters = Type.Object({
	kind: StringEnum(["bug", "enhancement"] as const, { description: "The feedback classification" }),
	title: Type.String({ description: "Concise final GitHub issue title" }),
	whatHappened: Type.Optional(Type.String({ description: "Bug: What happened?" })),
	stepsToReproduce: Type.Optional(Type.String({ description: "Bug: Steps to reproduce" })),
	expectedBehavior: Type.Optional(Type.String({ description: "Bug: Expected behavior" })),
	version: Type.Optional(Type.String({ description: "Bug: Atomic version" })),
	nonBuiltinExtensionState: Type.Optional(
		StringEnum(["active", "inactive", "unknown"] as const, {
			description: "Bug: whether non-builtin extensions were active",
		}),
	),
	extensionFreeReproduction: Type.Optional(
		StringEnum(["reproduced", "not-reproduced", "unknown"] as const, {
			description: "Bug: whether the issue was reproduced with atomic -ne",
		}),
	),
	whatToChange: Type.Optional(Type.String({ description: "Enhancement: What do you want to change?" })),
	why: Type.Optional(Type.String({ description: "Enhancement: Why?" })),
	how: Type.Optional(Type.String({ description: "Enhancement: How? (optional)" })),
});

export type FeedbackSubmissionToolInput = Static<typeof FeedbackSubmissionParameters>;

export interface FeedbackSubmissionToolDetails {
	status: "posted" | "cancelled" | "retained";
	draft: FormattedFeedbackDraft;
	replacements: FeedbackPrivacyReplacement[];
	requestId?: string;
	uncertain?: boolean;
	url?: string;
	message?: string;
}

export interface FeedbackSubmissionToolOptions {
	getInvestigation(): FeedbackInvestigationController | undefined;
	post: FeedbackPostHandler;
	createRequestId?: () => string;
	onRetainedUncertainty?(): void;
	onTerminal(): void;
}

export interface FeedbackInteractionOutcome {
	status: "posted" | "cancelled" | "retained";
	preview: ScrubbedFeedbackDraft;
	requestId?: string;
	uncertain?: boolean;
	url?: string;
	message?: string;
}

function toFeedbackDraft(input: FeedbackSubmissionToolInput, nonBuiltinExtensionsLoaded: boolean): FeedbackDraft {
	if (input.kind === "bug") {
		return {
			kind: "bug",
			title: input.title,
			whatHappened: input.whatHappened ?? "",
			stepsToReproduce: input.stepsToReproduce ?? "",
			...(input.expectedBehavior === undefined ? {} : { expectedBehavior: input.expectedBehavior }),
			...(input.version === undefined ? {} : { version: input.version }),
			nonBuiltinExtensionState: nonBuiltinExtensionsLoaded ? "active" : "inactive",
			extensionFreeReproduction: input.extensionFreeReproduction as ExtensionFreeReproduction,
		};
	}
	return {
		kind: "enhancement",
		title: input.title,
		whatToChange: input.whatToChange ?? "",
		why: input.why ?? "",
		...(input.how === undefined ? {} : { how: input.how }),
	};
}

export function prepareFeedbackSubmission(
	input: FeedbackSubmissionToolInput,
	assessment: FeedbackInvestigationAssessment,
): ScrubbedFeedbackDraft {
	const formatted = formatFeedbackDraft(toFeedbackDraft(input, assessment.nonBuiltinExtensionsLoaded));
	const additions: string[] = [];
	if (assessment.status === "unavailable") additions.push(`## Investigation\n\n${assessment.message}`);
	if (assessment.workingTree !== undefined) {
		additions.push(`## Working-tree disclosure\n\n${formatWorkingTreeDisclosure(assessment.workingTree)}`);
	}
	const complete =
		additions.length === 0 ? formatted : { ...formatted, body: `${formatted.body}\n\n${additions.join("\n\n")}` };
	return scrubFeedbackDraft(complete);
}

type FeedbackActionTheme = ConstructorParameters<typeof FeedbackPreviewComponent>[1];

interface FeedbackActionView {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): boolean;
}

async function openAction<TAction extends string>(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	createComponent: (theme: FeedbackActionTheme, done: (action: TAction | undefined) => void) => FeedbackActionView,
): Promise<TAction | undefined> {
	return await ctx.ui.custom<TAction | undefined>(
		(tui, theme, _keybindings, done) => {
			const component = createComponent(theme, done);
			return {
				render: (width) => component.render(width),
				invalidate: () => component.invalidate(),
				handleInput: (data) => {
					const handled = component.handleInput(data);
					if (handled) tui.requestRender();
					return handled;
				},
			};
		},
		{ signal },
	);
}

async function openPreview(
	ctx: ExtensionContext,
	preview: ScrubbedFeedbackDraft,
	signal?: AbortSignal,
): Promise<FeedbackPreviewAction | undefined> {
	return await openAction(ctx, signal, (theme, done) => new FeedbackPreviewComponent(preview, theme, done));
}

async function openFailure(
	ctx: ExtensionContext,
	message: string,
	signal?: AbortSignal,
): Promise<FeedbackFailureAction | undefined> {
	return await openAction(ctx, signal, (theme, done) => new FeedbackFailureComponent(message, theme, done));
}

async function openEdit(
	ctx: ExtensionContext,
	preview: ScrubbedFeedbackDraft,
): Promise<{ title: string; body: string } | undefined> {
	if (ctx.ui.hostInputForm) {
		const values = await ctx.ui.hostInputForm({
			title: "Edit feedback issue",
			fields: [
				{ name: "title", type: "string", required: true, initialValue: preview.draft.title },
				{ name: "body", type: "text", required: true, initialValue: preview.draft.body },
			],
		});
		if (values === undefined) return undefined;
		return { title: values.title ?? "", body: values.body ?? "" };
	}
	const title = await ctx.ui.editor("Edit feedback issue title", preview.draft.title);
	if (title === undefined) return undefined;
	const body = await ctx.ui.editor("Edit feedback issue body", preview.draft.body);
	if (body === undefined) return undefined;
	return { title, body };
}

type FeedbackInteractionStep = { status: "continue"; failureMessage?: string } | FeedbackInteractionOutcome;

function uncertainRetentionMessage(requestId: string): string {
	return `Issue creation is still uncertain. Request ${requestId} and the complete reviewed draft are retained for reconciliation before Retry.`;
}

function cancelInteraction(controller: FeedbackSubmissionController): FeedbackInteractionOutcome {
	const uncertain = controller.creationUncertain;
	if (controller.state !== "retained") controller.cancel();
	return uncertain
		? {
				status: "retained",
				preview: controller.preview,
				requestId: controller.requestId,
				uncertain: true,
				message: uncertainRetentionMessage(controller.requestId),
			}
		: { status: "cancelled", preview: controller.preview, requestId: controller.requestId };
}

async function applyFeedbackEdits(ctx: ExtensionContext, controller: FeedbackSubmissionController): Promise<boolean> {
	while (true) {
		const edit = await openEdit(ctx, controller.preview);
		if (edit === undefined) return false;
		try {
			controller.applyEdit(edit);
			return true;
		} catch (error) {
			if (error instanceof FeedbackSubmissionTransitionError) throw error;
			ctx.ui.notify(error instanceof Error ? error.message : "Feedback edit is invalid.", "error");
		}
	}
}

async function handlePreviewState(
	ctx: ExtensionContext,
	controller: FeedbackSubmissionController,
	post: FeedbackPostHandler,
	signal?: AbortSignal,
): Promise<FeedbackInteractionStep> {
	const action = await openPreview(ctx, controller.preview, signal);
	if (action === undefined || action === "cancel") return cancelInteraction(controller);
	if (action === "edit") {
		controller.beginEdit();
		return (await applyFeedbackEdits(ctx, controller)) ? { status: "continue" } : cancelInteraction(controller);
	}
	const outcome = await controller.submit(post, signal);
	return outcome.status === "posted"
		? { status: "posted", preview: controller.preview, requestId: controller.requestId, url: outcome.url }
		: { status: "continue", failureMessage: outcome.message };
}

async function handleFailureState(
	ctx: ExtensionContext,
	controller: FeedbackSubmissionController,
	post: FeedbackPostHandler,
	failureMessage: string | undefined,
	signal?: AbortSignal,
): Promise<FeedbackInteractionStep> {
	const action = await openFailure(ctx, failureMessage ?? "Issue posting failed.", signal);
	if (action === "retry") {
		const outcome = await controller.submit(post, signal);
		return outcome.status === "posted"
			? { status: "posted", preview: controller.preview, requestId: controller.requestId, url: outcome.url }
			: { status: "continue", failureMessage: outcome.message };
	}
	if (action === "copy") {
		ctx.ui.setEditorText(formatFeedbackDraftForCopy(controller.preview));
		const uncertain = controller.creationUncertain;
		if (controller.state !== "retained") controller.retain();
		return {
			status: "retained",
			preview: controller.preview,
			requestId: controller.requestId,
			...(uncertain ? { uncertain: true } : {}),
			message: uncertain
				? `${uncertainRetentionMessage(controller.requestId)} The draft was copied to the editor.`
				: "The complete reviewed draft was copied to the editor.",
		};
	}
	return cancelInteraction(controller);
}

interface FeedbackInteractionOptions {
	signal?: AbortSignal;
	createRequestId?: () => string;
	controller?: FeedbackSubmissionController;
	failureMessage?: string;
}

export async function runFeedbackInteraction(
	ctx: ExtensionContext,
	initial: ScrubbedFeedbackDraft,
	post: FeedbackPostHandler,
	options: FeedbackInteractionOptions = {},
): Promise<FeedbackInteractionOutcome> {
	if (!ctx.hasUI) {
		return options.controller?.creationUncertain
			? {
					status: "retained",
					preview: options.controller.preview,
					requestId: options.controller.requestId,
					uncertain: true,
					message: uncertainRetentionMessage(options.controller.requestId),
				}
			: {
					status: "retained",
					preview: initial,
					message: "Interactive feedback review is unavailable. The complete scrubbed draft is retained.",
				};
	}
	const controller = options.controller ?? new FeedbackSubmissionController(initial, options.createRequestId);
	let failureMessage = options.failureMessage;
	while (true) {
		const step =
			controller.state === "preview"
				? await handlePreviewState(ctx, controller, post, options.signal)
				: await handleFailureState(ctx, controller, post, failureMessage, options.signal);
		if (step.status !== "continue") return step;
		failureMessage = step.failureMessage;
	}
}

interface RetainedFeedbackSubmission {
	controller: FeedbackSubmissionController;
	failureMessage?: string;
}
function createSubmissionController(
	input: FeedbackSubmissionToolInput,
	options: FeedbackSubmissionToolOptions,
): FeedbackSubmissionController {
	const investigation = options.getInvestigation();
	if (investigation === undefined) throw new Error("No active /feedback request is available for submission.");
	const assessment = investigation.assess(input.kind);
	return new FeedbackSubmissionController(prepareFeedbackSubmission(input, assessment), options.createRequestId);
}

function retainedSubmissionAfter(
	outcome: FeedbackInteractionOutcome,
	controller: FeedbackSubmissionController,
	options: FeedbackSubmissionToolOptions,
): RetainedFeedbackSubmission | undefined {
	if (outcome.status === "retained" && outcome.uncertain) {
		options.onRetainedUncertainty?.();
		return { controller, failureMessage: outcome.message };
	}
	options.onTerminal();
	return undefined;
}

function feedbackSubmissionDetails(outcome: FeedbackInteractionOutcome): FeedbackSubmissionToolDetails {
	return {
		status: outcome.status,
		draft: outcome.preview.draft,
		replacements: outcome.preview.replacements,
		...(outcome.requestId === undefined ? {} : { requestId: outcome.requestId }),
		...(outcome.uncertain === undefined ? {} : { uncertain: outcome.uncertain }),
		...(outcome.url === undefined ? {} : { url: outcome.url }),
		...(outcome.message === undefined ? {} : { message: outcome.message }),
	};
}

export function createFeedbackSubmissionTool(
	options: FeedbackSubmissionToolOptions,
): ToolDefinition<typeof FeedbackSubmissionParameters, FeedbackSubmissionToolDetails> {
	let retainedSubmission: RetainedFeedbackSubmission | undefined;
	return {
		name: "submit_feedback",
		label: "Submit feedback",
		description:
			"Validate, privacy-review, preview, edit, and explicitly confirm one Atomic bug report or enhancement. This tool is the only feedback path allowed to post to GitHub.",
		promptSnippet: "Preview and explicitly confirm one privacy-reviewed Atomic feedback issue",
		promptGuidelines: [
			"Use submit_feedback exactly once after classifying and drafting a /feedback request; never post feedback through bash.",
		],
		parameters: FeedbackSubmissionParameters,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const controller = retainedSubmission?.controller ?? createSubmissionController(input, options);
			const outcome = await runFeedbackInteraction(ctx, controller.preview, options.post, {
				signal,
				controller,
				failureMessage: retainedSubmission?.failureMessage,
			});
			retainedSubmission = retainedSubmissionAfter(outcome, controller, options);
			const details = feedbackSubmissionDetails(outcome);
			if (outcome.status === "posted" && outcome.url) {
				return { content: [{ type: "text", text: outcome.url }], details, terminate: true };
			}
			const text =
				outcome.status === "cancelled"
					? "Feedback cancelled. No issue was created."
					: (outcome.message ?? "The complete reviewed feedback draft is retained.");
			return { content: [{ type: "text", text }], details, terminate: true };
		},
	};
}

export function buildModelUnavailableFallbackDraft(
	prompt: string,
	facts: { version: string; nonBuiltinExtensionsLoaded: boolean },
	kind: FeedbackKind,
): FeedbackDraft {
	if (kind === "bug") {
		return {
			kind,
			title: "Atomic bug report (drafting model unavailable)",
			whatHappened: `${prompt}\n\nDrafting model unavailable.\n\nInvestigation unavailable`,
			stepsToReproduce: "Not provided because the drafting model was unavailable.",
			version: facts.version,
			nonBuiltinExtensionState: facts.nonBuiltinExtensionsLoaded ? "active" : "inactive",
			extensionFreeReproduction: "unknown",
		};
	}
	return {
		kind,
		title: "Atomic enhancement (drafting model unavailable)",
		whatToChange: prompt,
		why: `Drafting model unavailable.\n\nSafe metadata:\n- Atomic version: ${facts.version}\n- Non-builtin extensions loaded: ${facts.nonBuiltinExtensionsLoaded ? "yes" : "no"}\n\nEdit this field before posting if more context is needed.`,
	};
}

export function prepareModelUnavailableFallback(
	prompt: string,
	facts: { version: string; nonBuiltinExtensionsLoaded: boolean },
	kind: FeedbackKind,
): ScrubbedFeedbackDraft {
	return scrubFeedbackDraft(formatFeedbackDraft(buildModelUnavailableFallbackDraft(prompt, facts, kind)));
}
