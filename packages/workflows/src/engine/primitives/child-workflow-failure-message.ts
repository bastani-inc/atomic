import type { RunStatus } from "../../shared/store-types.js";

/**
 * The error a parent reports when its child workflow fails, and the inverse that strips it again. Both live
 * here so the text a parent writes and the text a later parent strips cannot drift apart (#4031).
 */
const LEAD = "atomic-workflows: child workflow ";
const SEPARATOR = ") failed with status ";
const ERROR_SEPARATOR = ": ";

/** Every run status, so a separator is only taken where a real status follows it. */
const RUN_STATUSES: Readonly<Record<RunStatus, true>> = {
	pending: true,
	running: true,
	paused: true,
	completed: true,
	skipped: true,
	cancelled: true,
	blocked: true,
	failed: true,
	killed: true,
};

/** `atomic-workflows: child workflow "<alias>" (<display name>) failed with status <status>[: <error>]`. */
export function childWorkflowFailureMessage(
	alias: string,
	displayName: string,
	status: RunStatus,
	error: string | undefined,
): string {
	return `${LEAD}"${alias}" (${displayName}${SEPARATOR}${status}${error !== undefined ? `${ERROR_SEPARATOR}${error}` : ""}`;
}

/**
 * The text after one child-workflow failure prefix, or `undefined` when `text` does not start with one.
 * Names are never parsed: the prefix ends at the first status separator this module writes, so names
 * with parentheses, quotes or colons are skipped whole.
 */
function afterChildWorkflowPrefix(text: string): string | undefined {
	if (!text.startsWith(`${LEAD}"`)) return undefined;
	for (let at = text.indexOf(SEPARATOR, LEAD.length); at >= 0; at = text.indexOf(SEPARATOR, at + 1)) {
		const rest = text.slice(at + SEPARATOR.length);
		for (const status of Object.keys(RUN_STATUSES)) {
			if (!rest.startsWith(status)) continue;
			const after = rest.slice(status.length);
			if (after === "") return "";
			if (after.startsWith(ERROR_SEPARATOR)) return after.slice(ERROR_SEPARATOR.length);
		}
	}
	return undefined;
}

/** A failed child's own error text, without the child-workflow failure prefixes of any depth around it. */
export function withoutChildWorkflowFailurePrefixes(text: string): string {
	let current = text;
	for (let inner = afterChildWorkflowPrefix(current); inner !== undefined; inner = afterChildWorkflowPrefix(current))
		current = inner;
	return current;
}
