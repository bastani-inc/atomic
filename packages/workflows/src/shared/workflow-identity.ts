import type { RunSnapshot } from "./store-types.js";

/** One-line identity shared by programmatic resume clients and the picker. */
export function workflowIdentity(
	id: string,
	label: string | undefined,
	inputs: RunSnapshot["inputs"] | undefined,
): string {
	const text =
		label?.trim() ||
		[inputs?.objective, inputs?.prompt, inputs?.task, inputs?.request, ...Object.values(inputs ?? {})].find(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		) ||
		id;
	return text.replace(/\s+/g, " ").trim();
}
