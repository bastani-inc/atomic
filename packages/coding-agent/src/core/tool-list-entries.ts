/** Whether a tool list entry adds (`+name`) or removes (`-name`) a tool rather than naming one. */
export function isToolModifier(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

/** Why a tool list is invalid: names mixed with `+name`/`-name` entries, or a pattern in one; undefined when valid. */
export function getToolListError(entries: readonly string[]): string | undefined {
	const modifiers = entries.filter(isToolModifier);
	if (modifiers.length === 0) return undefined;
	if (modifiers.length < entries.length) return "tool names cannot be mixed with +name or -name entries";
	const pattern = modifiers.find((entry) => entry.includes("*"));
	if (pattern) return `+name and -name entries take exact tool names, not patterns: ${pattern}`;
	return undefined;
}
