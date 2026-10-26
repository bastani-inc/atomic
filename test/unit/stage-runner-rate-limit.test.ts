import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentSessionAdapter, InternalStageContext, StageSessionRuntime } from "./stage-runner-helpers.js";
import {
	assistantMessageWithUsage,
	createStageContext,
	flushMicrotasks,
	makeMockSession,
	makeOpts,
} from "./stage-runner-helpers.js";

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

async function settleOnFakeTimers<T>(
	pending: Promise<T>,
	stepMs = 500,
	maxSteps = 200,
): Promise<{ value: T } | { error: unknown }> {
	const outcome = pending.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	let settled = false;
	void outcome.then(() => {
		settled = true;
	});
	for (let step = 0; step < maxSteps && !settled; step++) await vi.advanceTimersByTimeAsync(stepMs);
	// A prompt that never settles fails here, with this reason, instead of hanging until the Vitest timeout.
	assert.ok(settled, `the prompt did not settle within ${maxSteps * stepMs} ms of fake time`);
	return outcome;
}

test("persistent 429 responses stop after the configured retry count and cooldown rounds (#3864, #3984)", async () => {
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
	const started = Date.now();
	const outcome = await settleOnFakeTimers(ctx.prompt("go"));
	assert.ok("error" in outcome);
	assert.match(String(outcome.error), /429/);
	// maxRetries+1 calls per round, and at most maxRetries whole-chain cooldown rounds after the first.
	assert.equal(calls, 9);
	assert.equal(ctx.__modelFallbackMeta().modelAttempts?.length, 9);
	// Every wait is one recorded 1 s cooldown: eight of them between nine calls.
	assert.equal(Date.now() - started <= 8_500, true);
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

test.each([false, true])(
	"an explicit-model 429 on a follow-up retries the same conversation, tool round=%s (#3864)",
	async (withToolRound) => {
		let creates = 0;
		let throttled = false;
		const histories: string[][] = [];
		const transcripts: StageSessionRuntime["messages"][] = [];
		const ctx = createStageContext(
			makeOpts({
				stageOptions: { model: "follow-up-429/model" },
				adapters: {
					agentSession: {
						async create() {
							creates++;
							const history: string[] = [];
							histories.push(history);
							const messages: StageSessionRuntime["messages"] = [];
							transcripts.push(messages);
							return {
								session: makeMockSession({
									messages,
									async prompt(text) {
										messages.push({ role: "user", content: text, timestamp: Date.now() });
										if (text === "second" && !throttled) {
											throttled = true;
											if (withToolRound) {
												const assistant = assistantMessageWithUsage("", {
													input: 1,
													output: 1,
													cacheRead: 0,
													cacheWrite: 0,
													cost: 0,
												});
												assert.ok(assistant.role === "assistant");
												assistant.content = [
													{ type: "toolCall", id: "call", name: "lookup", arguments: {} },
												];
												messages.push(assistant, {
													role: "toolResult",
													toolCallId: "call",
													toolName: "lookup",
													content: [{ type: "text", text: "result" }],
													isError: false,
													timestamp: Date.now(),
												});
											}
											throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
										}
										history.push(text, `answer to ${text}`);
										messages.push(
											assistantMessageWithUsage(`answer to ${text}`, {
												input: 0,
												output: 0,
												cacheRead: 0,
												cacheWrite: 0,
												cost: 0,
											}),
										);
										return `answer to ${text}`;
									},
									getLastAssistantText: () => history.at(-1),
								}).session,
								settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
							};
						},
					},
				},
			}),
		) as InternalStageContext;
		assert.equal(await ctx.prompt("first"), "answer to first");
		const pending = ctx.prompt("second");
		void pending.catch(() => {});
		try {
			await vi.advanceTimersByTimeAsync(2000);
			assert.equal(await pending, "answer to second");
			assert.equal(creates, 1);
			assert.deepEqual(histories[0], ["first", "answer to first", "second", "answer to second"]);
			assert.deepEqual(
				transcripts[0]!.map((message) => message.role),
				["user", "assistant", "user", "assistant"],
			);
			const firstMessage = transcripts[0]![0]!;
			assert.ok(firstMessage.role === "user");
			assert.equal(firstMessage.content, "first");
		} finally {
			await ctx.abort();
			await pending.catch(() => {});
		}
	},
);

test("a rate-limited follow-up exhausts its retry budget and cooldown rounds without restarting the conversation (#3864, #3984)", async () => {
	let creates = 0;
	let followUps = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "exhausted-follow-up/model" },
			adapters: {
				agentSession: {
					async create() {
						creates++;
						return {
							session: makeMockSession({
								async prompt(text) {
									if (text === "first") return "ok";
									followUps++;
									throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 1000 });
								},
							}).session,
							settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
						};
					},
				},
			},
		}),
	) as InternalStageContext;
	assert.equal(await ctx.prompt("first"), "ok");
	const started = Date.now();
	try {
		const outcome = await settleOnFakeTimers(ctx.prompt("second"));
		assert.ok("error" in outcome);
		assert.match(String(outcome.error), /429/);
		// Two calls per round (maxRetries 1), and one whole-chain cooldown round.
		assert.equal(followUps, 4);
		assert.equal(creates, 1);
		assert.equal(Date.now() - started <= 3_500, true);
	} finally {
		await ctx.abort();
	}
});

test("a follow-up revisits an earlier account after its cooldown (#3864)", async () => {
	const calls: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "follow-up-a/model", fallbackModels: ["follow-up-b/model"] },
			adapters: {
				agentSession: {
					async create(options) {
						const model = String(options.model);
						return {
							session: makeMockSession({
								async prompt(text) {
									if (text === "first") return "ok";
									calls.push(model);
									if (model === "follow-up-b/model" || calls.length === 1)
										throw Object.assign(new Error("429 Too Many Requests"), {
											retryAfterMs: model === "follow-up-a/model" ? 20 : 100,
										});
									return "recovered";
								},
								getLastAssistantText: () => "recovered",
							}).session,
							settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
						};
					},
				},
			},
		}),
	) as InternalStageContext;
	await ctx.prompt("first");
	const pending = ctx.prompt("second");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, ["follow-up-a/model", "follow-up-b/model"]);
		await vi.advanceTimersByTimeAsync(19);
		assert.equal(calls.length, 2);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(calls, ["follow-up-a/model", "follow-up-b/model", "follow-up-a/model"]);
		assert.equal(await pending, "recovered");
	} finally {
		await ctx.abort();
		await pending.catch(() => {});
	}
});

test("a follow-up keeps each model's retry budget across resumed and fallback sessions (#3864, #3984)", async () => {
	const calls: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "follow-up-budget/a", fallbackModels: ["follow-up-budget/b"] },
			adapters: {
				agentSession: {
					async create(options) {
						const model = String(options.model);
						return {
							session: makeMockSession({
								async prompt(text) {
									if (text === "first") return "ok";
									calls.push(model);
									throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 20 });
								},
							}).session,
							settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
						};
					},
				},
			},
		}),
	) as InternalStageContext;
	assert.equal(await ctx.prompt("first"), "ok");
	const started = Date.now();
	try {
		const outcome = await settleOnFakeTimers(ctx.prompt("second"), 20);
		assert.ok("error" in outcome);
		assert.match(String(outcome.error), /429/);
		// maxRetries+1 calls per model per round, with one whole-chain cooldown round.
		assert.equal(calls.filter((model) => model === "follow-up-budget/a").length, 4);
		assert.equal(calls.filter((model) => model === "follow-up-budget/b").length, 4);
		assert.equal(Date.now() - started <= 400, true);
	} finally {
		await ctx.abort();
	}
});

test("a cooled follow-up on a successful fallback does not reopen rejected earlier models (#3864)", async () => {
	const calls: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "rejected-earlier/model", fallbackModels: ["continued-fallback/model"] },
			adapters: {
				agentSession: {
					async create(options) {
						const model = String(options.model);
						const history: string[] = [];
						return {
							session: makeMockSession({
								async prompt(text) {
									calls.push(model);
									if (model === "rejected-earlier/model") throw new Error("503 service unavailable");
									history.push(text);
									return history.join(";");
								},
								getLastAssistantText: () => history.join(";"),
							}).session,
							settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }) },
						};
					},
				},
			},
		}),
	) as InternalStageContext;
	assert.equal(await ctx.prompt("first"), "first");
	const seed = limitedContext(
		"continued-fallback",
		async () => {
			throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
		},
		undefined,
		0,
	);
	await assert.rejects(seed.prompt("seed"), /429/);
	const pending = ctx.prompt("second");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, ["rejected-earlier/model", "continued-fallback/model"]);
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(await pending, "first;second");
		assert.deepEqual(calls, ["rejected-earlier/model", "continued-fallback/model", "continued-fallback/model"]);
	} finally {
		await ctx.abort();
		await seed.abort();
		await pending.catch(() => {});
	}
});

test("a chain whose every candidate exhausted its 429 budget waits for the earliest cooldown instead of failing (#3984)", async () => {
	const calls: string[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			return {
				session: makeMockSession({
					async prompt() {
						calls.push(model);
						if (calls.length <= 4)
							throw Object.assign(new Error("429 Too Many Requests"), {
								retryAfterMs: model.startsWith("chain-wait-a/") ? 3000 : 1000,
							});
						return "ok";
					},
					getLastAssistantText: () => "ok",
				}).session,
				settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }) },
			};
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "chain-wait-a/model", fallbackModels: ["chain-wait-b/model"] },
		}),
	) as InternalStageContext;
	try {
		const outcome = await settleOnFakeTimers(ctx.prompt("go"), 500, 50);
		assert.deepEqual(outcome, { value: "ok" });
		// Both accounts spent their budget; the next attempt goes to the account whose cooldown ends first.
		assert.equal(calls.length, 5);
		assert.equal(calls[4], "chain-wait-b/model");
	} finally {
		await ctx.abort();
	}
});

function fallbackChainContext(
	models: readonly [string, ...string[]],
	fail: (model: string, call: number) => Error | undefined,
	calls: string[],
): InternalStageContext {
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			return {
				session: makeMockSession({
					async prompt() {
						calls.push(model);
						const failure = fail(model, calls.length);
						if (failure) throw failure;
						return "ok";
					},
					getLastAssistantText: () => "ok",
				}).session,
				settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: 0 }) },
			};
		},
	};
	const [model, ...fallbackModels] = models;
	return createStageContext(
		makeOpts({ adapters: { agentSession }, stageOptions: { model, fallbackModels } }),
	) as InternalStageContext;
}

test("an exhausted quota whose reset is hours away moves straight to the fallback without waiting", async () => {
	const calls: string[] = [];
	const reset = new Date(Date.now() + 5 * 60 * 60 * 1000).toUTCString();
	const ctx = fallbackChainContext(
		["quota-a/model", "quota-b/model"],
		(model) =>
			model === "quota-a/model"
				? Object.assign(new Error("402 Payment Required"), {
						status: 402,
						headers: new Headers({ "Retry-After": reset }),
					})
				: undefined,
		calls,
	);
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(await pending, "ok");
		assert.deepEqual(calls, ["quota-a/model", "quota-b/model"]);
		assert.ok(ctx.__modelFallbackMeta().rateLimits?.every((limit) => limit.waitingUntil === undefined));
	} finally {
		await ctx.abort();
	}
});

test("a 429 naming the limited model does not delay another model on the same provider", async () => {
	const calls: string[] = [];
	const ctx = fallbackChainContext(
		["scoped-account/model-a", "scoped-account/model-b"],
		(model) =>
			model === "scoped-account/model-a"
				? Object.assign(new Error("429 Rate limit reached for model-a in your organization"), {
						status: 429,
						headers: new Headers({ "Retry-After": "30" }),
					})
				: undefined,
		calls,
	);
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(await pending, "ok");
		assert.deepEqual(calls, ["scoped-account/model-a", "scoped-account/model-b"]);
	} finally {
		await ctx.abort();
	}
});

test("a 429 that does not name a model still cools every model on the provider", async () => {
	const calls: string[] = [];
	const ctx = fallbackChainContext(
		["unscoped-account/model-a", "unscoped-account/model-b"],
		(model) =>
			model === "unscoped-account/model-a"
				? Object.assign(new Error("429 Too Many Requests"), {
						status: 429,
						headers: new Headers({ "Retry-After": "30" }),
					})
				: undefined,
		calls,
	);
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, ["unscoped-account/model-a"]);
		await vi.advanceTimersByTimeAsync(29_999);
		assert.deepEqual(calls, ["unscoped-account/model-a"]);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(await pending, "ok");
		assert.equal(calls.length, 2);
	} finally {
		await ctx.abort();
	}
});

test("a 529 overload honors its retry hint like a 503", async () => {
	let calls = 0;
	const ctx = limitedContext("overloaded-account", async () => {
		calls += 1;
		if (calls === 1) {
			throw Object.assign(new Error('529 {"type":"error","error":{"type":"unknown_error","message":"try later"}}'), {
				retryAfterMs: 3000,
			});
		}
		return "ok";
	});
	const pending = ctx.prompt("go");
	void pending.catch(() => {});
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(2999);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(await pending, "ok");
		assert.equal(calls, 2);
	} finally {
		await ctx.abort();
	}
});

test("a ready candidate recovers a cooling chain even when the other's cooldown exceeds the cap (#3984)", async () => {
	const calls: string[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			return {
				session: makeMockSession({
					async prompt() {
						calls.push(model);
						const primaryCalls = calls.filter((call) => call === model).length;
						if (model.startsWith("ready-b/"))
							throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 2000 });
						if (primaryCalls <= 2) throw Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 10 });
						return "ok";
					},
					getLastAssistantText: () => "ok",
				}).session,
				settingsManager: {
					getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0, maxRetryDelayMs: 1000 }),
				},
			};
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "ready-a/model", fallbackModels: ["ready-b/model"] },
		}),
	) as InternalStageContext;
	try {
		const outcome = await settleOnFakeTimers(ctx.prompt("go"));
		// The fallback's 2 s cooldown exceeds the 1 s cap, so it leaves the walk while the primary still has a
		// candidate's chance; the primary's 10 ms cooldown is already over, so it recovers without a cooldown wait
		// instead of the stage failing with 429.
		assert.deepEqual(outcome, { value: "ok" });
		assert.deepEqual(calls, ["ready-a/model", "ready-b/model", "ready-a/model", "ready-a/model"]);
	} finally {
		await ctx.abort();
	}
});
