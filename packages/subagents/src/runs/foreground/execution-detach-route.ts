export interface IntercomDetachRoute {
	phase?: unknown;
	requestId?: unknown;
	messageId?: unknown;
	senderId?: unknown;
	childIntercomTarget?: unknown;
	runId?: unknown;
	agent?: unknown;
	childIndex?: unknown;
	runtimeGeneration?: unknown;
}

export function matchesIntercomDetachRoute(
	event: IntercomDetachRoute,
	expected: { childIntercomTarget?: string; runId?: string; agent: string; childIndex: number },
): boolean {
	const exactTarget = typeof event.childIntercomTarget === "string"
		&& event.childIntercomTarget.length > 0
		&& event.childIntercomTarget === expected.childIntercomTarget;
	const completeTuple = typeof event.runId === "string"
		&& typeof event.agent === "string"
		&& typeof event.childIndex === "number";
	return exactTarget || (completeTuple
		&& event.runId === expected.runId
		&& event.agent === expected.agent
		&& event.childIndex === expected.childIndex);
}
