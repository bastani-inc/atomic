import type { AgentMessage } from "@bastani/atomic-agent-core";

/** Provenance belongs to this page, not to an arbitrary SDK message reused in a different task. */
const origins = new WeakMap<readonly AgentMessage[], ReadonlyMap<AgentMessage, string>>();
const rendered = new WeakMap<object, string>();
export function bindSavedTaskOrigins(messages: readonly AgentMessage[], keys: ReadonlyMap<AgentMessage, string>): void {
	origins.set(messages, keys);
}
export function savedTaskRows(
	messages: readonly AgentMessage[],
): ((entry: object, message: AgentMessage, part: number) => void) | undefined {
	const keys = origins.get(messages);
	if (!keys) return undefined;
	return (entry, message, part) => {
		const key = keys.get(message);
		if (key !== undefined) rendered.set(entry, `${key}:${part}`);
	};
}
export function savedTaskRowKey(entry: object): string | undefined {
	return rendered.get(entry);
}
/** Gives `entry` the saved row of another entry that draws the same saved record, such as a card standing in for it. */
export function bindSavedTaskRowKey(entry: object, key: string): void {
	rendered.set(entry, key);
}
