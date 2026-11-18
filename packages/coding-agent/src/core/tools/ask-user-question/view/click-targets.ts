import { ClickableRows } from "@bastani/atomic-tui";

/** What a click in the questionnaire lands on: a row of the current tab, a tab, or a choice on the review tab. */
export type QuestionnaireClickTarget =
	| { readonly kind: "option"; readonly index: number }
	| { readonly kind: "chat" }
	| { readonly kind: "tab"; readonly index: number }
	| { readonly kind: "submit"; readonly index: 0 | 1 };

/** The key a view marks its drawn text with, naming `target`. */
export function clickTargetKey(target: QuestionnaireClickTarget): string {
	return target.kind === "chat" ? "chat" : `${target.kind}:${target.index}`;
}

/**
 * `text` marked as drawing `target`, so the session learns where it landed once the dialog has laid it out. The mark
 * ends with the text, so a column laid out beside it is not part of the target.
 */
export function markClickTarget(target: QuestionnaireClickTarget, text: string): string {
	return `${ClickableRows.mark(clickTargetKey(target), text)}${ClickableRows.END_MARK}`;
}

/** The target a key from {@link clickTargetKey} names. */
export function parseClickTarget(key: string): QuestionnaireClickTarget | undefined {
	if (key === "chat") return { kind: "chat" };
	const [kind, raw] = key.split(":");
	const index = Number(raw);
	if (!Number.isInteger(index) || index < 0) return undefined;
	if (kind === "option" || kind === "tab") return { kind, index };
	if (kind === "submit" && (index === 0 || index === 1)) return { kind, index };
	return undefined;
}
