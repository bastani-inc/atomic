import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAuthorizedRoute, CursorExecutionAuthorityScheduler, CursorExecutionAuthorityTimer, CursorExecutionRouteAuthorizer } from "../../packages/cursor/src/execution-authority.js";
import { deriveCursorCredentialScope } from "../../packages/cursor/src/catalog-cache.js";
import { CursorExecutionAuthority, type CursorExecutionAuthorityRuntime } from "../../packages/cursor/src/execution-authority.js";
import { CursorMessageReader, readNextCursorMessage } from "../../packages/cursor/src/stream-reader.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { collectEvents, context, model, testAuthorizedRoute } from "./cursor-stream-helpers.js";

function authorization(overrides: Partial<CursorAuthorizedRoute> = {}): CursorAuthorizedRoute {
	return testAuthorizedRoute({
		modelId: model().id,
		maxMode: false,
		credentialScope: "scope-a",
		catalogGeneration: 1,
		...overrides,
	});
}

const exactTestAuthorization = authorization();
const exactTestAuthorityRoutes = new Map<string, CursorAuthorizedRoute>([
	[exactTestAuthorization.modelId, exactTestAuthorization],
]);
const exactTestAuthority: CursorExecutionRouteAuthorizer = async (selected: Model<Api>) => {
	const route = exactTestAuthorityRoutes.get(selected.id);
	if (!route) throw new Error(`Cursor model ${selected.id} is not in the test GetUsable authority.`);
	return route;
};

function toolResultContext(): Context {
	return { messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
}

function token(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

interface ManualTimer extends CursorExecutionAuthorityTimer {
	readonly callback: () => void;
	cancelled: boolean;
}

class ManualAuthorityScheduler implements CursorExecutionAuthorityScheduler {
	readonly timers: ManualTimer[] = [];
	schedule(callback: () => void, _delayMs: number): CursorExecutionAuthorityTimer {
		const timer: ManualTimer = {
			callback,
			cancelled: false,
			cancel() { this.cancelled = true; },
		};
		this.timers.push(timer);
		return timer;
	}
	clear(timer: CursorExecutionAuthorityTimer): void {
		timer.cancel();
	}
	fire(timer = this.timers.at(-1)): void {
		if (timer && !timer.cancelled) timer.callback();
	}
}

class PostRaceAbortSignal extends EventTarget implements AbortSignal {
	readonly reason = new Error("post-race abort");
	onabort: ((this: AbortSignal, event: Event) => void) | null = null;
	readonly [Symbol.toStringTag] = "AbortSignal";
	#reads = 0;
	get aborted(): boolean {
		this.#reads += 1;
		return this.#reads > 1;
	}
	throwIfAborted(): void {
		if (this.aborted) throw this.reason;
	}
}

function liveAuthorityHarness(): {
	readonly authority: CursorExecutionAuthority;
	readonly accessToken: string;
	readonly scope: string;
	readonly runtime: CursorExecutionAuthorityRuntime;
	setNow(value: number): void;
} {
	let currentTime = 100;
	const accessToken = token("stream-authority-race");
	const scope = deriveCursorCredentialScope(accessToken);
	if (!scope) throw new Error("Expected test credential scope");
	const authority = new CursorExecutionAuthority({ now: () => currentTime, ttlMs: 10 });
	authority.publish({ source: "live", fetchedAt: 100, models: [{ id: model().id, maxMode: false }] }, scope, 1);
	return {
		authority,
		accessToken,
		scope,
		runtime: { isActive: () => true, activeCredentialScope: () => scope, now: () => currentTime, ttlMs: 10, discover: () => undefined },
		setNow(value) { currentTime = value; },
	};
}

function occurrenceModel(id: string, catalogOccurrence: number, maxMode: boolean, supportsImages: boolean): Model<Api> {
	return {
		...model(),
		id,
		name: id,
		input: supportsImages ? ["text", "image"] : ["text"],
		compat: {
			cursorRouting: { [id]: { modelId: id, maxMode, supportsImages, catalogOccurrence } },
		},
	} as Model<Api>;
}

test("message reader rejects a message when abort becomes visible after the race winner", async () => {
	const messages = (async function* () {
		yield { type: "textDelta", text: "must stay buffered" } as const;
	})();
	const reader = new CursorMessageReader(messages);
	const raced = await readNextCursorMessage(reader, new PostRaceAbortSignal(), 100);
	assert.equal(raced.kind, "aborted");
	const retry = await readNextCursorMessage(reader, undefined, 100);
	assert.equal(retry.kind, "message");
	if (retry.kind === "message") assert.equal(retry.result.done ? undefined : retry.result.value.type, "textDelta");
});

test("execution authority actively expires and clears identity-fenced lease timers", async () => {
	let currentTime = 100;
	const scheduler = new ManualAuthorityScheduler();
	const accessToken = token("timer-account");
	const scope = deriveCursorCredentialScope(accessToken);
	if (!scope) throw new Error("Expected timer credential scope");
	const authority = new CursorExecutionAuthority({ now: () => currentTime, ttlMs: 10, scheduler });
	const runtime: CursorExecutionAuthorityRuntime = {
		isActive: () => true,
		activeCredentialScope: () => scope,
		now: () => currentTime,
		ttlMs: 10,
		discover: () => undefined,
	};
	authority.publish({ source: "live", fetchedAt: 100, models: [{ id: model().id, maxMode: false }] }, scope, 1);
	const firstTimer = scheduler.timers[0];
	const first = await authority.authorize(model(), accessToken, undefined, runtime);
	assert.equal(first.authoritySignal.aborted, false);

	currentTime = 101;
	authority.publish({ source: "live", fetchedAt: 101, models: [{ id: model().id, maxMode: true }] }, scope, 2);
	assert.equal(firstTimer?.cancelled, true);
	firstTimer?.callback();
	const second = await authority.authorize(model(), accessToken, undefined, runtime);
	assert.equal(second.authoritySignal.aborted, false, "stale timer callback must not revoke the replacement lease");

	currentTime = 111;
	scheduler.fire();
	assert.equal(second.authoritySignal.aborted, true);
	assert.throws(() => second.assertCurrent(), /TTL-valid|expired|changed/u);
	authority.close();
});

test("execution authority preserves blank and duplicate occurrences and follows the selected current model object", async () => {
	const accessToken = token("occurrence-account");
	const scope = deriveCursorCredentialScope(accessToken);
	if (!scope) throw new Error("Expected occurrence credential scope");
	const authority = new CursorExecutionAuthority({ now: () => 100, ttlMs: 10 });
	const runtime: CursorExecutionAuthorityRuntime = {
		isActive: () => true,
		activeCredentialScope: () => scope,
		now: () => 100,
		ttlMs: 10,
		discover: () => undefined,
	};
	authority.publish({
		source: "live",
		fetchedAt: 100,
		models: [
			{ id: "", maxMode: false },
			{ id: "   ", maxMode: true },
			{ id: "duplicate", maxMode: false },
			{ id: "duplicate", maxMode: true, supportsImages: true },
		],
	}, scope, 1);

	assert.equal((await authority.authorize(occurrenceModel("", 0, false, false), accessToken, undefined, runtime)).modelId, "");
	assert.equal((await authority.authorize(occurrenceModel("   ", 1, true, false), accessToken, undefined, runtime)).maxMode, true);
	const firstDuplicate = await authority.authorize(occurrenceModel("duplicate", 2, false, false), accessToken, undefined, runtime);
	const laterDuplicate = await authority.authorize(occurrenceModel("duplicate", 3, true, true), accessToken, undefined, runtime);
	assert.deepEqual([firstDuplicate.maxMode, firstDuplicate.supportsImages], [false, false]);
	assert.deepEqual([laterDuplicate.maxMode, laterDuplicate.supportsImages], [true, true]);

	authority.publish({ source: "live", fetchedAt: 100, models: [{ id: "duplicate", maxMode: false }] }, scope, 2);
	assert.equal(firstDuplicate.authoritySignal.aborted, true);
	const refreshed = await authority.authorize(occurrenceModel("duplicate", 3, true, true), accessToken, undefined, runtime);
	assert.deepEqual([refreshed.maxMode, refreshed.supportsImages], [false, false]);
	authority.close();
});

test("TTL expiry actively aborts a silent transport and removes its active turn", async () => {
	let currentTime = 100;
	const scheduler = new ManualAuthorityScheduler();
	const accessToken = token("active-stream-expiry");
	const scope = deriveCursorCredentialScope(accessToken);
	if (!scope) throw new Error("Expected active-stream credential scope");
	const authority = new CursorExecutionAuthority({ now: () => currentTime, ttlMs: 10, scheduler });
	const runtime: CursorExecutionAuthorityRuntime = {
		isActive: () => true,
		activeCredentialScope: () => scope,
		now: () => currentTime,
		ttlMs: 10,
		discover: () => undefined,
	};
	authority.publish({ source: "live", fetchedAt: 100, models: [{ id: model().id, maxMode: false }] }, scope, 1);
	let releaseMessages = (): void => {};
	const transport = new CursorMockTransport({
		messageFactory: () => (async function* (): AsyncIterable<never> {
			await new Promise<void>((resolve) => { releaseMessages = resolve; });
		})(),
	});
	const adapter = new CursorStreamAdapter({
		transport,
		executionAuthorizer: (selected, tokenValue, signal) => authority.authorize(selected, tokenValue, signal, runtime),
	});
	const eventsPromise = collectEvents(adapter.streamSimple(model(), context(), { apiKey: accessToken }));
	while (transport.runs.length === 0) await Promise.resolve();
	await Promise.resolve();
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);
	currentTime = 110;
	scheduler.fire();
	const events = await eventsPromise;
	releaseMessages();
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(events.some((event) => event.type === "done"), false);
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	assert.equal(transport.getLifecycleSnapshot().openStreams, 0);
	authority.close();
	await adapter.dispose();
});

test("stream rechecks authority after every inbound read and removes aborted turns", async () => {
	for (const messages of [
		[{ type: "textDelta", text: "stale" }, { type: "done", reason: "stop" }] as const,
		[{ type: "usage", inputTokens: 9, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: "done", reason: "stop" }] as const,
		[] as const,
	]) {
		let checks = 0;
		const route = testAuthorizedRoute({
			assertCurrent() {
				checks += 1;
				if (checks >= 2) throw new Error("authority changed after inbound read");
			},
		});
		const transport = new CursorMockTransport({ messages });
		const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => route });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		assert.equal(events.some((event) => event.type === "text_delta" || event.type === "done"), false);
		assert.equal(events.at(-1)?.type, "error");
		const terminal = events.at(-1);
		if (terminal?.type === "error") assert.equal(terminal.error.usage.totalTokens, 0);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		assert.equal(transport.getLifecycleSnapshot().openStreams, 0);
		await adapter.dispose();
	}
});

test("positive stream fixture is one exact flat authority route without parameterized compatibility", () => {
	const selected = model();
	const route = testAuthorizedRoute();
	assert.equal(selected.id, "cursor-grok-4.5-high");
	assert.equal(selected.reasoning, false);
	assert.equal(selected.thinkingLevelMap, undefined);
	assert.equal(selected.compat, undefined);
	assert.equal(route.modelId, selected.id);
	assert.equal(route.maxMode, true);
});

test("unbound Cursor stream adapters reject before transport", async () => {
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const adapter = new CursorStreamAdapter({ transport });
	const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	await adapter.dispose();
});

test("explicit test authority supplies the exact route", async () => {
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: exactTestAuthority });
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
	assert.equal(transport.runs[0]?.request.resolvedModelId, model().id);
	await adapter.dispose();
});

test("explicit test authority rejects a fabricated caller outside its route map", async () => {
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: exactTestAuthority });
	const fabricated = { ...model(), id: "fabricated-route", name: "fabricated-route" };
	assert.equal(fabricated.compat, undefined);
	const events = await collectEvents(adapter.streamSimple(fabricated, context(), { apiKey: "access-secret" }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	await adapter.dispose();
});

for (const scenario of ["publish", "revoke", "expire", "close"] as const) {
	test(`live authority blocks ${scenario} between authorization and transport`, async () => {
		const harness = liveAuthorityHarness();
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({
			transport,
			executionAuthorizer: async (selected, accessToken, signal) => {
				const route = await harness.authority.authorize(selected, accessToken, signal, harness.runtime);
				if (scenario === "publish") harness.authority.publish({ source: "live", fetchedAt: 101, models: [{ id: selected.id, maxMode: true }] }, harness.scope, 2);
				else if (scenario === "revoke") harness.authority.revoke();
				else if (scenario === "expire") harness.setNow(110);
				else harness.authority.close();
				return route;
			},
		});
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: harness.accessToken }));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 0);
		await adapter.dispose();
	});
}

test("paused tool turns resume only under the unchanged authority lease", async () => {
	const transport = new CursorMockTransport({ messages: [
		{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" },
		{ type: "textDelta", text: "done" },
		{ type: "done", reason: "stop" },
	] });
	const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => exactTestAuthorization });
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "same-authority" }));
	const events = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "same-authority" }));
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(transport.runs.length, 1);
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 1);
	await adapter.dispose();
});

for (const scenario of [
	{ name: "account switch", next: authorization({ credentialScope: "scope-b", authorityLease: Symbol("account-b") }) },
	{ name: "catalog generation change", next: authorization({ catalogGeneration: 2, authorityLease: Symbol("generation-2") }) },
	{ name: "Max change", next: authorization({ maxMode: true, authorityLease: exactTestAuthorization.authorityLease }) },
] as const) {
	test(`paused tool turns reject ${scenario.name} before writing results`, async () => {
		let current = exactTestAuthorization;
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" },
			{ type: "textDelta", text: "done" },
		] });
		const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => current });
		await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: scenario.name }));
		current = scenario.next;
		const events = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: scenario.name }));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
		assert.equal(transport.runs[0]?.stream.cancelled, true);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		await adapter.dispose();
	});
}

test("paused tool turns are cancelled when the current route is removed or expired", async () => {
	let rejectAuthorization = false;
	const transport = new CursorMockTransport({ messages: [{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" }] });
	const adapter = new CursorStreamAdapter({
		transport,
		executionAuthorizer: async () => {
			if (rejectAuthorization) throw new Error("current Cursor route expired or was removed");
			return exactTestAuthorization;
		},
	});
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "removed-route" }));
	rejectAuthorization = true;
	const events = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "removed-route" }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
	assert.equal(transport.runs[0]?.stream.cancelled, true);
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	await adapter.dispose();
});

test("execution authority installation is one-shot", async () => {
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: exactTestAuthority });
	assert.throws(() => adapter.bindExecutionAuthority(async () => authorization({ modelId: "fabricated" })), /already bound/u);
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
	assert.equal(transport.runs[0]?.request.resolvedModelId, model().id);
	await adapter.dispose();
});
