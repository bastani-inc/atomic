/** An error's message followed by the messages of its causes, so a wrapped storage failure keeps its origin. */
export function describeErrorWithCauses(error: unknown): string {
	const messages: string[] = [];
	for (let current = error; current !== undefined && messages.length < 5; ) {
		const message = current instanceof Error ? current.message : String(current);
		if (!messages.includes(message)) messages.push(message);
		current = current instanceof Error ? current.cause : undefined;
	}
	return messages.join(": ");
}
