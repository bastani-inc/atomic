export interface IntercomDetachRoute {
	phase?: unknown;
	requestId?: unknown;
	messageId?: unknown;
	senderId?: unknown;
	childIntercomTarget?: unknown;
	runtimeGeneration?: unknown;
}

export function matchesIntercomDetachRoute(
	event: IntercomDetachRoute,
	expected: { childIntercomTarget?: string },
): boolean {
	return typeof event.childIntercomTarget === "string"
		&& event.childIntercomTarget.length > 0
		&& event.childIntercomTarget === expected.childIntercomTarget;
}
