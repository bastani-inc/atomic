export const FEEDBACK_REPOSITORY = { owner: "bastani-inc", repo: "atomic" } as const;
export interface IssueFieldDescriptor {
	readonly id: string;
	readonly label: string;
	readonly required: boolean;
}
export const BUG_ISSUE_FIELDS = [
	{ id: "description", label: "What happened?", required: true },
	{ id: "repro", label: "Steps to reproduce", required: true },
	{ id: "expected", label: "Expected behavior", required: false },
	{ id: "version", label: "Version", required: false },
] as const satisfies readonly IssueFieldDescriptor[];
export const ENHANCEMENT_ISSUE_FIELDS = [
	{ id: "change", label: "What do you want to change?", required: true },
	{ id: "why", label: "Why?", required: true },
	{ id: "how", label: "How? (optional)", required: false },
] as const satisfies readonly IssueFieldDescriptor[];
export const ISSUE_LABELS = { bug: "bug", enhancement: "enhancement" } as const;
export interface BugFeedbackDraft {
	readonly kind: "bug";
	readonly title: string;
	readonly description: string;
	readonly repro: string;
	readonly expected?: string;
	readonly version?: string;
}
export interface EnhancementFeedbackDraft {
	readonly kind: "enhancement";
	readonly title: string;
	readonly change: string;
	readonly why: string;
	readonly how?: string;
}
export type FeedbackDraft = BugFeedbackDraft | EnhancementFeedbackDraft;
type FeedbackFormFieldId = (typeof BUG_ISSUE_FIELDS)[number]["id"] | (typeof ENHANCEMENT_ISSUE_FIELDS)[number]["id"];
type FeedbackFormFieldDescriptor = IssueFieldDescriptor & { readonly id: FeedbackFormFieldId };
export type FeedbackFieldId = "title" | FeedbackFormFieldId;
export interface DraftValidationError {
	readonly field: FeedbackFieldId;
	readonly message: string;
}
export type DraftValidationResult =
	| { readonly ok: true; readonly draft: FeedbackDraft }
	| { readonly ok: false; readonly errors: readonly DraftValidationError[] };

function required(field: FeedbackFieldId, label: string, value: string): DraftValidationError | undefined {
	return value.trim() ? undefined : { field, message: `${label} is required` };
}
function formFields(draft: FeedbackDraft): readonly FeedbackFormFieldDescriptor[] {
	return draft.kind === "bug" ? BUG_ISSUE_FIELDS : ENHANCEMENT_ISSUE_FIELDS;
}
function formValue(draft: FeedbackDraft, id: FeedbackFormFieldId): string | undefined {
	return (draft as FeedbackDraft & Partial<Record<FeedbackFormFieldId, string>>)[id];
}
export function validateFeedbackDraft(draft: FeedbackDraft): DraftValidationResult {
	const candidates = [
		required("title", "Title", draft.title),
		...formFields(draft)
			.filter(({ required: isRequired }) => isRequired)
			.map(({ id, label }) => required(id, label, formValue(draft, id) ?? "")),
	];
	const errors = candidates.filter((error): error is DraftValidationError => error !== undefined);
	return errors.length ? { ok: false, errors } : { ok: true, draft };
}
export function assertPostableDraft(draft: FeedbackDraft): FeedbackDraft {
	const result = validateFeedbackDraft(draft);
	if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join("; "));
	return result.draft;
}
function section(label: string, value: string): string {
	return `### ${label}\n\n${value}`;
}
export function formatIssueBody(draft: FeedbackDraft): string {
	assertPostableDraft(draft);
	return formFields(draft)
		.flatMap(({ id, label }) => {
			const value = formValue(draft, id);
			return value?.trim() ? [section(label, value)] : [];
		})
		.join("\n\n");
}
