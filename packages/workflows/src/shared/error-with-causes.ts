const MAX_CAUSE_DEPTH = 5;

/** An error's message followed by the messages of its causes, so a wrapped storage failure keeps its origin. */
export function describeErrorWithCauses(error: unknown): string {
	const messages: string[] = [];
	const visited = new Set<unknown>();
	let current = error;
	for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH && !visited.has(current); depth++) {
		visited.add(current);
		const message = current instanceof Error ? current.message : String(current);
		if (!messages.includes(message)) messages.push(message);
		current = current instanceof Error ? current.cause : undefined;
	}
	return messages.join(": ");
}
