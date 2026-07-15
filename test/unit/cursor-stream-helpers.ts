import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai/compat";
import type { CursorAuthorizedRoute, CursorExecutionRouteAuthorizer } from "../../packages/cursor/src/execution-authority.js";
import type { CursorStreamAdapterOptions } from "../../packages/cursor/src/stream.js";
import { CursorStreamAdapter as ProductionCursorStreamAdapter } from "../../packages/cursor/src/stream.js";

export const TEST_CURSOR_MODEL_ID = "cursor-grok-4.5-high";
const TEST_CURSOR_AUTHORITY_LEASE = Symbol("test-cursor-authority");
const TEST_CURSOR_AUTHORITY_SIGNAL = new AbortController().signal;

export function testAuthorizedRoute(overrides: Partial<CursorAuthorizedRoute> = {}): CursorAuthorizedRoute {
	return {
		modelId: TEST_CURSOR_MODEL_ID,
		maxMode: true,
		supportsImages: false,
		authorityLease: TEST_CURSOR_AUTHORITY_LEASE,
		authoritySignal: TEST_CURSOR_AUTHORITY_SIGNAL,
		credentialScope: "test-cursor-scope",
		catalogGeneration: 1,
		assertCurrent() {},
		...overrides,
	};
}

interface TestCursorStreamAdapterOptions extends Omit<CursorStreamAdapterOptions, "executionAuthorizer"> {
	readonly authorizedRoutes?: readonly CursorAuthorizedRoute[];
}

export class TestCursorStreamAdapter extends ProductionCursorStreamAdapter {
	constructor(options: TestCursorStreamAdapterOptions) {
		const { authorizedRoutes = [testAuthorizedRoute()], ...streamOptions } = options;
		const routes = new Map(authorizedRoutes.map((route) => [route.modelId, route]));
		const authorizer: CursorExecutionRouteAuthorizer = async (selected) => {
			const route = routes.get(selected.id);
			if (!route) throw new Error(`Cursor model ${selected.id} is not an exact route in the authenticated catalog.`);
			return route;
		};
		super({ ...streamOptions, executionAuthorizer: authorizer });
	}
}

export function model(): Model<Api> {
	return {
		id: TEST_CURSOR_MODEL_ID,
		name: "Cursor Grok 4.5 High",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
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
