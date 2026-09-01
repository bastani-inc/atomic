export const FEEDBACK_REPOSITORY = "bastani-inc/atomic" as const;
export const NOT_TESTED_WITHOUT_EXTENSIONS = "Not tested without extensions" as const;

export type FeedbackKind = "bug" | "enhancement";

export interface FeedbackTemplateField {
	id: string;
	label: string;
	required: boolean;
}

export interface FeedbackTemplate {
	kind: FeedbackKind;
	repository: typeof FEEDBACK_REPOSITORY;
	label: FeedbackKind;
	fields: readonly FeedbackTemplateField[];
}

export const FEEDBACK_TEMPLATES = {
	bug: {
		kind: "bug",
		repository: FEEDBACK_REPOSITORY,
		label: "bug",
		fields: [
			{ id: "description", label: "What happened?", required: true },
			{ id: "repro", label: "Steps to reproduce", required: true },
			{ id: "expected", label: "Expected behavior", required: false },
			{ id: "version", label: "Version", required: false },
		],
	},
	enhancement: {
		kind: "enhancement",
		repository: FEEDBACK_REPOSITORY,
		label: "enhancement",
		fields: [
			{ id: "change", label: "What do you want to change?", required: true },
			{ id: "why", label: "Why?", required: true },
			{ id: "how", label: "How? (optional)", required: false },
		],
	},
} as const satisfies Record<FeedbackKind, FeedbackTemplate>;

export type NonBuiltinExtensionState = "active" | "inactive" | "unknown";
export type ExtensionFreeReproduction = "reproduced" | "not-reproduced" | "unknown";

interface FeedbackDraftBase {
	title: string;
}

export interface BugFeedbackDraft extends FeedbackDraftBase {
	kind: "bug";
	whatHappened: string;
	stepsToReproduce: string;
	expectedBehavior?: string;
	version?: string;
	nonBuiltinExtensionState: NonBuiltinExtensionState;
	extensionFreeReproduction: ExtensionFreeReproduction;
}

export interface EnhancementFeedbackDraft extends FeedbackDraftBase {
	kind: "enhancement";
	whatToChange: string;
	why: string;
	how?: string;
}

export type FeedbackDraft = BugFeedbackDraft | EnhancementFeedbackDraft;

export interface FormattedFeedbackDraft {
	repository: typeof FEEDBACK_REPOSITORY;
	kind: FeedbackKind;
	label: FeedbackKind;
	title: string;
	body: string;
}

export class FeedbackValidationError extends Error {
	readonly missingFields: readonly string[];

	constructor(missingFields: readonly string[]) {
		super(`Missing required feedback fields: ${missingFields.join(", ")}`);
		this.name = "FeedbackValidationError";
		this.missingFields = missingFields;
	}
}

function isBlank(value: string | undefined): boolean {
	return value === undefined || value.trim().length === 0;
}

function section(label: string, value: string): string[] {
	return [`## ${label}`, value];
}

function optionalSection(label: string, value: string | undefined): string[] {
	return value === undefined ? [] : section(label, value);
}

function extensionStateText(state: NonBuiltinExtensionState): string {
	switch (state) {
		case "active":
			return "Active";
		case "inactive":
			return "Inactive";
		case "unknown":
			return "Unknown";
	}
}

function extensionFreeReproductionText(state: ExtensionFreeReproduction): string {
	switch (state) {
		case "reproduced":
			return "Reproduced without extensions";
		case "not-reproduced":
			return "Not reproduced without extensions";
		case "unknown":
			return NOT_TESTED_WITHOUT_EXTENSIONS;
	}
}

function missingBugFields(draft: BugFeedbackDraft): string[] {
	const missing: string[] = [];
	if (isBlank(draft.whatHappened)) missing.push(FEEDBACK_TEMPLATES.bug.fields[0].label);
	if (isBlank(draft.stepsToReproduce)) missing.push(FEEDBACK_TEMPLATES.bug.fields[1].label);
	if (!(["active", "inactive", "unknown"] as const).includes(draft.nonBuiltinExtensionState)) {
		missing.push("Non-builtin extension state");
	}
	if (!(["reproduced", "not-reproduced", "unknown"] as const).includes(draft.extensionFreeReproduction)) {
		missing.push("Extension-free reproduction status");
	}
	return missing;
}

function missingEnhancementFields(draft: EnhancementFeedbackDraft): string[] {
	const missing: string[] = [];
	if (isBlank(draft.whatToChange)) missing.push(FEEDBACK_TEMPLATES.enhancement.fields[0].label);
	if (isBlank(draft.why)) missing.push(FEEDBACK_TEMPLATES.enhancement.fields[1].label);
	return missing;
}

export function validateFeedbackDraft(draft: FeedbackDraft): void {
	if (draft.kind !== "bug" && draft.kind !== "enhancement") throw new FeedbackValidationError(["kind"]);
	const missingFields = [
		...(isBlank(draft.title) ? ["title"] : []),
		...(draft.kind === "bug" ? missingBugFields(draft) : missingEnhancementFields(draft)),
	];
	if (missingFields.length > 0) throw new FeedbackValidationError(missingFields);
}

export function formatFeedbackDraft(draft: FeedbackDraft): FormattedFeedbackDraft {
	validateFeedbackDraft(draft);
	if (draft.kind === "bug") {
		const body = [
			...section(FEEDBACK_TEMPLATES.bug.fields[0].label, draft.whatHappened),
			...section(FEEDBACK_TEMPLATES.bug.fields[1].label, draft.stepsToReproduce),
			...optionalSection(FEEDBACK_TEMPLATES.bug.fields[2].label, draft.expectedBehavior),
			...optionalSection(FEEDBACK_TEMPLATES.bug.fields[3].label, draft.version),
			...section("Non-builtin extensions", extensionStateText(draft.nonBuiltinExtensionState)),
			...section("Extension-free reproduction", extensionFreeReproductionText(draft.extensionFreeReproduction)),
		].join("\n\n");
		return {
			repository: FEEDBACK_REPOSITORY,
			kind: draft.kind,
			label: FEEDBACK_TEMPLATES.bug.label,
			title: draft.title,
			body,
		};
	}

	const body = [
		...section(FEEDBACK_TEMPLATES.enhancement.fields[0].label, draft.whatToChange),
		...section(FEEDBACK_TEMPLATES.enhancement.fields[1].label, draft.why),
		...optionalSection(FEEDBACK_TEMPLATES.enhancement.fields[2].label, draft.how),
	].join("\n\n");
	return {
		repository: FEEDBACK_REPOSITORY,
		kind: draft.kind,
		label: FEEDBACK_TEMPLATES.enhancement.label,
		title: draft.title,
		body,
	};
}
