/** Shared value validation for custom/dynamic model-registry definitions. */

function isPositiveInteger(value: number): boolean {
	return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Validate a model `contextWindow` token count. Returns an error string when the
 * value is not a positive integer, or `undefined` when it is valid.
 */
export function validateContextWindowValue(value: number): string | undefined {
	return isPositiveInteger(value) ? undefined : "Context window must be a positive integer token count";
}
