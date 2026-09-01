import { randomUUID } from "node:crypto";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme-class.ts";
import { prepareFeedbackRequestPreview } from "./posting.js";
import type { ScrubbedFeedbackDraft } from "./privacy.js";
import { FEEDBACK_TEMPLATES, FeedbackValidationError, type FormattedFeedbackDraft } from "./templates.js";

export type FeedbackPreviewAction = "edit" | "post" | "cancel";
export type FeedbackFailureAction = "retry" | "copy" | "cancel";
export type FeedbackSubmissionState =
	| "preview"
	| "editing"
	| "submitting"
	| "failed"
	| "posted"
	| "cancelled"
	| "retained";

export interface FeedbackPostRequest {
	requestId: string;
	draft: FormattedFeedbackDraft;
}

export type FeedbackPostResult =
	| { status: "success"; url: string }
	| { status: "failure"; message: string }
	| { status: "uncertain"; message: string };

export type FeedbackPostHandler = (request: FeedbackPostRequest) => Promise<FeedbackPostResult>;

export type FeedbackSubmitOutcome =
	| { status: "posted"; url: string }
	| { status: "failed"; message: string; uncertain: boolean };

export interface FeedbackEditedPreview {
	title: string;
	body: string;
}

export class FeedbackSubmissionTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeedbackSubmissionTransitionError";
	}
}

function requiredBodyLabels(kind: FormattedFeedbackDraft["kind"]): readonly string[] {
	return kind === "bug"
		? [
				FEEDBACK_TEMPLATES.bug.fields[0].label,
				FEEDBACK_TEMPLATES.bug.fields[1].label,
				"Non-builtin extensions",
				"Extension-free reproduction",
			]
		: [FEEDBACK_TEMPLATES.enhancement.fields[0].label, FEEDBACK_TEMPLATES.enhancement.fields[1].label];
}

function sectionValue(body: string, label: string): string | undefined {
	const heading = `## ${label}`;
	const start = body.indexOf(heading);
	if (start === -1 || (start > 0 && body[start - 1] !== "\n")) return undefined;
	const valueStart = start + heading.length;
	if (body[valueStart] !== "\n") return undefined;
	const nextSection = body.indexOf("\n## ", valueStart + 1);
	return body.slice(valueStart + 1, nextSection === -1 ? body.length : nextSection).trim();
}

export function validateFeedbackPreview(draft: FormattedFeedbackDraft): void {
	const missing: string[] = [];
	if (draft.title.trim().length === 0) missing.push("title");
	for (const label of requiredBodyLabels(draft.kind)) {
		if (!sectionValue(draft.body, label)) missing.push(label);
	}
	if (missing.length > 0) throw new FeedbackValidationError(missing);
}

const FEEDBACK_ISSUE_URL = /^https:\/\/github\.com\/bastani-inc\/atomic\/issues\/[1-9]\d*$/;

export class FeedbackSubmissionController {
	readonly requestId: string;
	#state: FeedbackSubmissionState = "preview";
	#preview: ScrubbedFeedbackDraft;
	#activeSubmission: Promise<FeedbackSubmitOutcome> | undefined;

	constructor(preview: ScrubbedFeedbackDraft, createRequestId: () => string = randomUUID) {
		validateFeedbackPreview(preview.draft);
		this.requestId = createRequestId();
		this.#preview = prepareFeedbackRequestPreview(preview, this.requestId);
		validateFeedbackPreview(this.#preview.draft);
	}

	get state(): FeedbackSubmissionState {
		return this.#state;
	}

	get preview(): ScrubbedFeedbackDraft {
		return this.#preview;
	}

	beginEdit(): void {
		if (this.#state !== "preview" && this.#state !== "failed") {
			throw new FeedbackSubmissionTransitionError(`Cannot edit feedback from ${this.#state}.`);
		}
		this.#state = "editing";
	}

	applyEdit(edit: FeedbackEditedPreview): void {
		if (this.#state !== "editing") {
			throw new FeedbackSubmissionTransitionError(`Cannot apply feedback edits from ${this.#state}.`);
		}
		const draft: FormattedFeedbackDraft = {
			...this.#preview.draft,
			title: edit.title,
			body: edit.body,
		};
		validateFeedbackPreview(draft);
		this.#preview = prepareFeedbackRequestPreview(
			{ draft, replacements: this.#preview.replacements },
			this.requestId,
		);
		validateFeedbackPreview(this.#preview.draft);
		this.#state = "preview";
	}

	cancel(): void {
		if (this.#state === "posted" || this.#state === "cancelled" || this.#state === "retained") {
			throw new FeedbackSubmissionTransitionError(`Cannot cancel feedback from ${this.#state}.`);
		}
		if (this.#state === "submitting") {
			throw new FeedbackSubmissionTransitionError("Cannot cancel while feedback submission is active.");
		}
		this.#state = "cancelled";
	}

	retain(): void {
		if (this.#state !== "failed") {
			throw new FeedbackSubmissionTransitionError(`Cannot retain feedback from ${this.#state}.`);
		}
		this.#state = "retained";
	}

	submit(post: FeedbackPostHandler): Promise<FeedbackSubmitOutcome> {
		if (this.#state === "submitting" && this.#activeSubmission) return this.#activeSubmission;
		if (this.#state !== "preview" && this.#state !== "failed") {
			throw new FeedbackSubmissionTransitionError(`Cannot post feedback from ${this.#state}.`);
		}
		this.#state = "submitting";
		const request: FeedbackPostRequest = { requestId: this.requestId, draft: this.#preview.draft };
		const pending = this.#runSubmission(post, request);
		this.#activeSubmission = pending;
		return pending;
	}

	async #runSubmission(post: FeedbackPostHandler, request: FeedbackPostRequest): Promise<FeedbackSubmitOutcome> {
		try {
			const result: FeedbackPostResult = await post(request);
			if (result.status === "success" && FEEDBACK_ISSUE_URL.test(result.url)) {
				this.#state = "posted";
				return { status: "posted", url: result.url };
			}
			this.#state = "failed";
			if (result.status === "failure") return { status: "failed", message: result.message, uncertain: false };
			if (result.status === "uncertain") return { status: "failed", message: result.message, uncertain: true };
			return { status: "failed", message: "GitHub returned an invalid issue response.", uncertain: false };
		} catch {
			this.#state = "failed";
			return {
				status: "failed",
				message: "Issue posting failed. The complete reviewed draft is retained.",
				uncertain: false,
			};
		} finally {
			this.#activeSubmission = undefined;
		}
	}
}

type FeedbackPreviewTheme = Pick<Theme, "fg" | "bold">;

function wrappedLines(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const sourceLine of text.split("\n")) {
		if (sourceLine.length === 0) {
			lines.push("");
			continue;
		}
		lines.push(...wrapTextWithAnsi(sourceLine, Math.max(1, width)));
	}
	return lines;
}

function labelledLine(theme: FeedbackPreviewTheme, label: string, value: string, width: number): string[] {
	const prefix = `${label}  `;
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) return wrappedLines(`${prefix}${value}`, width);
	const values = wrappedLines(value, width - prefixWidth);
	return values.map((line, index) => `${index === 0 ? theme.fg("muted", prefix) : " ".repeat(prefixWidth)}${line}`);
}

abstract class FeedbackActionComponent<TAction extends string> implements Component {
	protected selected = 0;
	readonly #actions: readonly { label: string; value: TAction }[];
	readonly #theme: FeedbackPreviewTheme;
	readonly #onAction: (action: TAction) => void;

	protected constructor(
		actions: readonly { label: string; value: TAction }[],
		theme: FeedbackPreviewTheme,
		onAction: (action: TAction) => void,
	) {
		this.#actions = actions;
		this.#theme = theme;
		this.#onAction = onAction;
	}

	abstract render(width: number): string[];

	protected get theme(): FeedbackPreviewTheme {
		return this.#theme;
	}

	protected actionLines(width: number): string[] {
		return this.#actions.map((action, index) => {
			const selected = index === this.selected;
			const prefix = selected ? this.#theme.fg("accent", "▸ ") : "  ";
			const label = selected
				? this.#theme.fg("accent", this.#theme.bold(action.label))
				: this.#theme.fg("muted", action.label);
			return truncateToWidth(`${prefix}${label}`, width, "");
		});
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.selected = (this.selected - 1 + this.#actions.length) % this.#actions.length;
			return true;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.selected = (this.selected + 1) % this.#actions.length;
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			const action = this.#actions[this.selected];
			if (action) this.#onAction(action.value);
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this.#onAction("cancel" as TAction);
			return true;
		}
		return false;
	}

	invalidate(): void {}
}

const PREVIEW_ACTIONS = [
	{ label: "Edit", value: "edit" },
	{ label: "Post issue", value: "post" },
	{ label: "Cancel", value: "cancel" },
] as const;

const PREVIEW_VIEWPORT_ROWS = 11;

export class FeedbackPreviewComponent extends FeedbackActionComponent<FeedbackPreviewAction> {
	readonly #preview: ScrubbedFeedbackDraft;
	#scrollOffset = 0;
	#lastContentLineCount = 0;

	constructor(
		preview: ScrubbedFeedbackDraft,
		theme: FeedbackPreviewTheme,
		onAction: (action: FeedbackPreviewAction) => void,
	) {
		super(PREVIEW_ACTIONS, theme, onAction);
		this.#preview = preview;
	}

	#contentLines(width: number): string[] {
		const lines: string[] = [];
		lines.push(...labelledLine(this.theme, "Repository", this.#preview.draft.repository, width));
		lines.push(...labelledLine(this.theme, "Kind", this.#preview.draft.kind, width));
		lines.push("", this.theme.fg("muted", this.theme.bold("TITLE")));
		lines.push(...wrappedLines(this.#preview.draft.title, width));
		lines.push("", this.theme.fg("muted", this.theme.bold("BODY")));
		lines.push(...wrappedLines(this.#preview.draft.body, width));
		lines.push("", this.theme.fg("muted", this.theme.bold("PRIVACY REVIEW")));
		if (this.#preview.replacements.length === 0) {
			lines.push(this.theme.fg("dim", "No automatic replacements."));
		} else {
			for (const replacement of this.#preview.replacements) {
				lines.push(...wrappedLines(`- ${replacement.description}`, width));
			}
		}
		return lines;
	}

	override handleInput(data: string): boolean {
		if (matchesKey(data, Key.pageUp)) {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - PREVIEW_VIEWPORT_ROWS);
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			const maxOffset = Math.max(0, this.#lastContentLineCount - PREVIEW_VIEWPORT_ROWS);
			this.#scrollOffset = Math.min(maxOffset, this.#scrollOffset + PREVIEW_VIEWPORT_ROWS);
			return true;
		}
		return super.handleInput(data);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const content = this.#contentLines(renderWidth);
		this.#lastContentLineCount = content.length;
		const maxOffset = Math.max(0, content.length - PREVIEW_VIEWPORT_ROWS);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
		const end = Math.min(content.length, this.#scrollOffset + PREVIEW_VIEWPORT_ROWS);
		const range = `Lines ${this.#scrollOffset + 1}-${end} of ${content.length}`;
		const rangeAndPaging =
			renderWidth >= 48
				? `${range} · PageUp/PageDown review`
				: `${this.#scrollOffset + 1}-${end}/${content.length} · PgUp/PgDn review`;
		const lines = [
			this.theme.fg("text", this.theme.bold("Feedback issue preview")),
			this.theme.fg("dim", rangeAndPaging),
			...content.slice(this.#scrollOffset, end),
			"",
			...this.actionLines(renderWidth),
			this.theme.fg("dim", "↑↓/Tab actions · Enter select · Esc cancel"),
		];
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}
}

const FAILURE_ACTIONS = [
	{ label: "Retry", value: "retry" },
	{ label: "Copy", value: "copy" },
	{ label: "Cancel", value: "cancel" },
] as const;

export class FeedbackFailureComponent extends FeedbackActionComponent<FeedbackFailureAction> {
	readonly #message: string;

	constructor(message: string, theme: FeedbackPreviewTheme, onAction: (action: FeedbackFailureAction) => void) {
		super(FAILURE_ACTIONS, theme, onAction);
		this.#message = message;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		return [
			...wrappedLines(this.theme.fg("error", this.#message), renderWidth),
			this.theme.fg("muted", "The complete reviewed draft is retained."),
			"",
			...this.actionLines(renderWidth),
			this.theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"),
		].map((line) => truncateToWidth(line, renderWidth, ""));
	}
}

export function formatFeedbackDraftForCopy(preview: ScrubbedFeedbackDraft): string {
	return `${preview.draft.title}\n\n${preview.draft.body}`;
}
