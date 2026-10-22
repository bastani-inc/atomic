import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import { createStageContext, flushMicrotasks, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("honors Retry-After before retrying a workflow provider account (#3864)", async () => {
	let calls = 0;
	const agentSession: AgentSessionAdapter = {
		async create() {
			const { session } = makeMockSession({
				async prompt() {
					calls += 1;
					if (calls === 1) {
						throw Object.assign(new Error("429 Too Many Requests"), {
							status: 429,
							headers: new Headers({ "Retry-After": "2" }),
						});
					}
					return "ok";
				},
			});
			return {
				session,
				settingsManager: {
					getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }),
				},
			};
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "retry-after-account/model" },
		}),
	) as InternalStageContext;
	const pending = ctx.prompt("go");
	try {
		await vi.advanceTimersByTimeAsync(0);
		await flushMicrotasks();
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(1999);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(await pending, "ok");
		assert.equal(calls, 2);
	} finally {
		await ctx.abort();
		await pending.catch(() => {});
	}
});

test("concurrent stages share a provider cooldown without blocking another account (#3864)", async () => {
	const calls: string[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			const { session } = makeMockSession({
				async prompt() {
					calls.push(model);
					if (calls.length === 1) throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
					return "ok";
				},
			});
			return {
				session,
				settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
			};
		},
	};
	const makeContext = (model: string) =>
		createStageContext(makeOpts({ adapters: { agentSession }, stageOptions: { model } })) as InternalStageContext;
	const first = makeContext("shared-account/a");
	const second = makeContext("shared-account/b");
	const other = makeContext("other-account/a");
	const pendingFirst = first.prompt("first");
	await vi.advanceTimersByTimeAsync(0);
	const pendingSecond = second.prompt("second");
	try {
		assert.equal(await other.prompt("other"), "ok");
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, ["shared-account/a", "other-account/a"]);
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(await pendingFirst, "ok");
		assert.equal(await pendingSecond, "ok");
	} finally {
		await Promise.all([first.abort(), second.abort(), other.abort()]);
		await Promise.allSettled([pendingFirst, pendingSecond]);
	}
});

test("all cooling candidates wait for the earliest account rather than exhausting the chain (#3864)", async () => {
	const calls: string[] = [];
	const counts = new Map<string, number>();
	const started = Date.now();
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			const { session } = makeMockSession({
				async prompt() {
					calls.push(model);
					const count = (counts.get(model) ?? 0) + 1;
					counts.set(model, count);
					if (count === 1)
						throw Object.assign(new Error("429 Too Many Requests"), {
							retryAfterMs: model.startsWith("earliest-a/") ? 2000 : 1000,
						});
					return "ok";
				},
			});
			return {
				session,
				settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
			};
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: {
				model: "earliest-a/model",
				fallbackModels: ["earliest-b/model"],
			},
		}),
	) as InternalStageContext;
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, ["earliest-a/model", "earliest-b/model"]);
		assert.deepEqual(ctx.__modelFallbackMeta().rateLimits, [
			{ provider: "earliest-a", rateLimitCount: 1, cooldownUntil: started + 2000 },
			{ provider: "earliest-b", rateLimitCount: 1, cooldownUntil: started + 1000, waitingUntil: started + 1000 },
		]);
		await vi.advanceTimersByTimeAsync(999);
		assert.equal(calls.length, 2);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(await pending, "ok");
		assert.deepEqual(calls, ["earliest-a/model", "earliest-b/model", "earliest-b/model"]);
		assert.ok(ctx.__modelFallbackMeta().rateLimits?.every((limit) => limit.waitingUntil === undefined));
	} finally {
		await ctx.abort();
		await pending.catch(() => {});
	}
});

function limitedContext(
	provider: string,
	prompt: (text: string) => Promise<string>,
	signal?: AbortSignal,
	maxRetries = 1,
): InternalStageContext {
	return createStageContext(
		makeOpts({
			signal,
			stageOptions: { model: `${provider}/model` },
			adapters: {
				agentSession: {
					async create() {
						let answer: string | undefined;
						return {
							session: makeMockSession({
								async prompt(text) {
									answer = await prompt(text);
									return answer;
								},
								getLastAssistantText: () => answer,
							}).session,
							settingsManager: {
								getRetrySettings: () => ({ enabled: true, maxRetries, baseDelayMs: 0 }),
							},
						};
					},
				},
			},
		}),
	) as InternalStageContext;
}

test("abort cancels a cooldown wait promptly and retains the reason (#3864)", async () => {
	const controller = new AbortController();
	let calls = 0;
	const ctx = limitedContext(
		"abort-cooldown",
		async () => {
			calls++;
			throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 120_000 });
		},
		controller.signal,
	);
	const pending = ctx.prompt("go");
	const reason = new Error("operator cancelled");
	const rejected = assert.rejects(pending, reason);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(calls, 1);
	controller.abort(reason);
	await rejected;
	assert.equal(calls, 1);
	assert.ok(ctx.__modelFallbackMeta().rateLimits?.every((limit) => limit.waitingUntil === undefined));
});

test("pause holds a cooldown retry and resume replaces its objective (#3864)", async () => {
	const texts: string[] = [];
	const ctx = limitedContext("pause-cooldown", async (text) => {
		texts.push(text);
		if (texts.length === 1) throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
		return "ok";
	});
	const pending = ctx.prompt("old objective");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		await ctx.__requestPause();
		await vi.advanceTimersByTimeAsync(2000);
		assert.deepEqual(texts, ["old objective"]);
		await ctx.__resume("replacement objective");
		assert.equal(await pending, "ok");
		assert.deepEqual(texts, ["old objective", "replacement objective"]);
	} finally {
		await ctx.abort();
		await pending.catch(() => {});
	}
});

test("resuming a cooldown without a replacement cancels the pending prompt (#3864)", async () => {
	let calls = 0;
	const ctx = limitedContext("cancel-cooldown", async () => {
		calls++;
		throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
	});
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	await vi.advanceTimersByTimeAsync(0);
	await ctx.__requestPause();
	await ctx.__resume();
	assert.equal(await pending, "");
	assert.equal(calls, 1);
});

test("persistent 429 responses stop at the configured retry count (#3864)", async () => {
	let calls = 0;
	const ctx = limitedContext(
		"bounded-cooldown",
		async () => {
			calls++;
			throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 1000 });
		},
		undefined,
		2,
	);
	const pending = ctx.prompt("go");
	const rejected = assert.rejects(pending, /429/);
	await vi.advanceTimersByTimeAsync(3000);
	await rejected;
	assert.equal(calls, 3);
	assert.equal(ctx.__modelFallbackMeta().modelAttempts?.length, 3);
});

test.each(["eager", "completed"])(
	"skipping a cooled %s session creates the ready fallback instead of relabeling it (#3864)",
	async (state) => {
		const calls: string[] = [];
		const disposed: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = String(options.model);
				return {
					session: makeMockSession({
						async prompt() {
							calls.push(model);
							return model;
						},
						getLastAssistantText: () => model,
						dispose: () => {
							disposed.push(model);
						},
					}).session,
				};
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "eager-a/primary",
					fallbackModels: ["eager-b/fallback"],
				},
			}),
		) as InternalStageContext;
		if (state === "eager") await ctx.__ensureSession();
		else await ctx.prompt("first");
		calls.length = 0;
		const seed = limitedContext(
			"eager-a",
			async () => {
				throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
			},
			undefined,
			0,
		);
		await assert.rejects(seed.prompt("seed"), /429/);
		assert.equal(await ctx.prompt("go"), "eager-b/fallback");
		assert.deepEqual(calls, ["eager-b/fallback"]);
		assert.deepEqual(disposed, ["eager-a/primary"]);
	},
);

test.each(["abort", "pause"])(
	"%s during a cooldown after fallback creation fails disposes the retired session (#3864)",
	async (action) => {
		const controller = new AbortController();
		let disposed = 0;
		const ctx = createStageContext(
			makeOpts({
				signal: controller.signal,
				stageOptions: { model: "cleanup-a/model", fallbackModels: ["cleanup-b/model"] },
				adapters: {
					agentSession: {
						async create(options) {
							if (String(options.model) === "cleanup-b/model")
								throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
							return makeMockSession({
								async prompt() {
									throw new Error("503 service unavailable");
								},
								dispose() {
									disposed++;
								},
							}).session;
						},
					},
				},
			}),
		) as InternalStageContext;
		const pending = ctx.prompt("go");
		const reason = new Error("cancel fallback wait");
		const outcome = pending.catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(0);
		if (action === "abort") {
			controller.abort(reason);
			assert.equal(await outcome, reason);
		} else {
			await ctx.__requestPause();
			await ctx.__resume();
			assert.equal(typeof (await outcome), "string");
		}
		assert.equal(disposed, 1);
	},
);

test("waiting for the same cooled account preserves a follow-up conversation (#3864)", async () => {
	let creates = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "conversation/model" },
			adapters: {
				agentSession: {
					async create() {
						creates++;
						const history: string[] = [];
						return makeMockSession({
							async prompt(text) {
								history.push(text);
								return history.join(";");
							},
							getLastAssistantText: () => history.join(";"),
						}).session;
					},
				},
			},
		}),
	) as InternalStageContext;
	assert.equal(await ctx.prompt("first"), "first");
	const seed = limitedContext(
		"conversation",
		async () => {
			throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
		},
		undefined,
		0,
	);
	await assert.rejects(seed.prompt("seed"), /429/);
	const pending = ctx.prompt("second");
	await vi.advanceTimersByTimeAsync(2000);
	assert.equal(await pending, "first;second");
	assert.equal(creates, 1);
});
