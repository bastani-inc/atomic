import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

export function model(): Model<Api> {
	return {
		id: "composer-2",
		name: "Composer 2",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		thinkingLevelMap: { high: "high", xhigh: "max" },
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

export function context(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

export interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

export function deferred(): Deferred {
	let resolveFn = (): void => {};
	const promise = new Promise<void>((resolve) => {
		resolveFn = resolve;
	});
	return { promise, resolve: resolveFn };
}

export async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>, onEvent?: (event: AssistantMessageEvent) => void): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent?.(event);
	}
	return events;
}

export async function collectEventsWithTimeout(stream: AsyncIterable<AssistantMessageEvent>, timeoutMs = 250): Promise<AssistantMessageEvent[]> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			collectEvents(stream),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("timed out waiting for cursor stream to end")), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

