import { test } from "vitest";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import {
	assert,
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
} from "./stage-runner-helpers.js";

// #3020: cancellation while failed-attempt shutdown drains must not allocate a fallback owner.
test.each(["abort", "dispose", "signal"] as const)(
	"%s during fallback cleanup prevents replacement initialization",
	async (action) => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const signal = new AbortController();
		let creations = 0;
		let shutdowns = 0;
		const ctx = createStageContext(
			makeOpts({
				signal: signal.signal,
				stageOptions: { model: "missing/primary", fallbackModels: ["available/fallback"] },
				adapters: {
					agentSession: {
						async create() {
							creations++;
							const { session } = makeMockSession({
								async prompt() {
									throw new Error("Unknown model: unavailable provider");
								},
							});
							return Object.assign(session, {
								extensionRunner: {
									hasHandlers: () => true,
									emit: async () => {
										shutdowns++;
										entered.resolve();
										await released.promise;
									},
								},
							});
						},
					},
				},
			}),
		) as InternalStageContext;
		const outcome = ctx.prompt("go").then(
			() => undefined,
			(error: Error) => error,
		);
		await entered.promise;
		const attachment = ctx.__ensureSession().then(
			() => undefined,
			(error: Error) => error,
		);
		const steering = ctx.steer("do not create after cancellation").then(
			() => undefined,
			(error: Error) => error,
		);
		const cancelled =
			action === "dispose"
				? ctx.__dispose()
				: action === "abort"
					? ctx.abort()
					: Promise.resolve(signal.abort(new Error("cancelled")));
		try {
			released.resolve();
			await cancelled;
			assert.ok((await outcome) instanceof Error);
			assert.ok((await attachment) instanceof Error);
			assert.ok((await steering) instanceof Error);
			assert.equal(creations, 1, "cancelled cleanup cannot create a successor session");
			assert.equal(shutdowns, 1, "concurrent disposal must join the same shutdown");
		} finally {
			released.resolve();
			await ctx.__dispose();
		}
	},
);

// #3020: a session that fails during binding never reaches the controller's ownership slot.
test("failed extension binding drains initialization cleanup before exposing the failure", async () => {
	const failure = new Error("Unknown model: initialization failed");
	const initialized = Promise.withResolvers<void>();
	const cleanupStarted = Promise.withResolvers<void>();
	let disposed = false;
	let cleaned = false;
	const { session } = makeMockSession({
		dispose() {
			disposed = true;
		},
	});
	const adapters = buildRuntimeAdapters(
		{},
		{
			createAgentSession: async () => ({
				session: Object.assign(session, {
					bindExtensions: async () => {
						throw failure;
					},
					extensionRunner: {
						hasHandlers: () => true,
						emit: async () => {
							cleanupStarted.resolve();
							await initialized.promise;
							cleaned = true;
						},
					},
				}),
			}),
		},
	);
	const outcome = adapters.agentSession!.create({}).then(
		() => undefined,
		(error: Error) => error,
	);
	try {
		const first = await Promise.race([cleanupStarted.promise.then(() => "cleanup"), outcome.then(() => "failure")]);
		assert.equal(first, "cleanup", "binding failure must not escape before lazy initialization cleanup");
		assert.equal(disposed, false);
		initialized.resolve();
		assert.equal(await outcome, failure);
		assert.equal(cleaned, true);
		assert.equal(disposed, true);
	} finally {
		initialized.resolve();
		await outcome;
	}
});

// #3020: a rejected shutdown does not prove release; all entrants must see the original error.
test("shutdown rejection fences concurrent and later attachment and steering", async () => {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const failure = new Error("Unknown model: ownership shutdown failed");
	let creations = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "missing/primary", fallbackModels: ["missing/secondary", "available/fallback"] },
			adapters: {
				agentSession: {
					async create() {
						creations++;
						return Object.assign(
							makeMockSession({
								async prompt() {
									throw new Error("Unknown model: primary");
								},
							}).session,
							{
								extensionRunner: {
									hasHandlers: () => true,
									async emit() {
										entered.resolve();
										await released.promise;
										throw failure;
									},
								},
							},
						);
					},
				},
			},
		}),
	) as InternalStageContext;
	const outcome = (promise: Promise<unknown>) =>
		promise.then(
			() => undefined,
			(error: Error) => error,
		);
	const prompt = outcome(ctx.prompt("go"));
	await entered.promise;
	const attachment = outcome(ctx.__ensureSession());
	const steer = outcome(ctx.steer("go"));
	try {
		released.resolve();
		assert.equal(await prompt, failure);
		assert.equal(await attachment, failure);
		assert.equal(await steer, failure);
		assert.equal(await outcome(ctx.__ensureSession()), failure);
		assert.equal(await outcome(ctx.steer("later")), failure);
		assert.equal(
			await outcome(ctx.prompt("later prompt must not treat cleanup failure as a model failure")),
			failure,
		);
		assert.equal(creations, 1);
	} finally {
		released.resolve();
		await ctx.__dispose();
	}
});

// #3020: concurrent attachment must not start a competing candidate walk after shutdown.
test("concurrent attachment shares successor creation failure and fallback accounting", async () => {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const attempts: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "absent/primary", fallbackModels: ["absent/secondary", "available/final"] },
			adapters: {
				agentSession: {
					async create(options) {
						const model = String(options.model);
						attempts.push(model);
						if (model === "absent/secondary") throw new Error("Unknown model: secondary");
						return Object.assign(
							makeMockSession({
								async prompt() {
									if (model === "absent/primary") throw new Error("Unknown model: primary");
								},
								getLastAssistantText: () => "completed",
							}).session,
							{
								extensionRunner: {
									hasHandlers: () => true,
									async emit() {
										entered.resolve();
										await released.promise;
									},
								},
							},
						);
					},
				},
			},
		}),
	) as InternalStageContext;
	const prompt = ctx.prompt("go");
	await entered.promise;
	const attachment = ctx.__ensureSession();
	const settled = Promise.allSettled([prompt, attachment]);
	try {
		released.resolve();
		assert.equal(await prompt, "completed");
		await attachment;
		assert.deepEqual(attempts, ["absent/primary", "absent/secondary", "available/final"]);
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.map(({ model }) => model),
			attempts,
		);
	} finally {
		released.resolve();
		await settled;
		await ctx.__dispose();
	}
});

// #3020 / #3021: failed binding cleanup is terminal even when either error looks retryable.
test.each(
	(["shutdown", "dispose", "both", "async-dispose"] as const).flatMap((mode) =>
		(["prompt", "eager", "steer"] as const).map((initiator) => ({ mode, initiator })),
	),
)(
	"failed binding $mode cleanup fences $initiator and all concurrent and later creation",
	async ({ mode, initiator }) => {
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const binding = new Error("Unknown model: primary unavailable");
		const shutdown = new Error("Unknown model: shutdown failed");
		const disposal = new Error("429 rate limit: disposal failed");
		let creations = 0;
		let disposals = 0;
		const adapters = buildRuntimeAdapters(
			{},
			{
				createAgentSession: async () => {
					creations++;
					return {
						session: Object.assign(makeMockSession({ prompt: async () => "completed" }).session, {
							bindExtensions: async () => {
								throw binding;
							},
							extensionRunner: {
								hasHandlers: () => true,
								emit: async () => {
									entered.resolve();
									await released.promise;
									if (mode === "shutdown" || mode === "both") throw shutdown;
								},
							},
							dispose: () => {
								disposals++;
								if (mode === "async-dispose") return Promise.reject(disposal);
								if (mode !== "shutdown") throw disposal;
							},
						}),
					};
				},
			},
		);
		const create = adapters.agentSession!.create;
		// A host may decorate an error's message. Ownership safety must use its type, not that label.
		adapters.agentSession!.create = async (...args) => {
			try {
				return await create(...args);
			} catch (error) {
				if (error instanceof AggregateError) error.message = "429 rate limit: retryable-looking cleanup failure";
				throw error;
			}
		};
		let retryPolicyReads = 0;
		const ctx = createStageContext(
			makeOpts({
				stageOptions: {
					model: "missing/primary",
					fallbackModels: ["available/fallback"],
					settingsManager: {
						getRetrySettings: () => {
							retryPolicyReads++;
							return { enabled: true, maxRetries: 2, baseDelayMs: 0 };
						},
					} as never,
				},
				adapters,
			}),
		) as InternalStageContext;
		const outcome = (promise: Promise<unknown>) =>
			promise.then(
				() => undefined,
				(error: Error) => error,
			);
		const first = outcome(
			initiator === "prompt"
				? ctx.prompt("original prompt")
				: initiator === "steer"
					? ctx.steer("first steer")
					: ctx.__ensureSession(),
		);
		await entered.promise;
		const prompt = outcome(ctx.prompt("original prompt"));
		const attachment = outcome(ctx.__ensureSession());
		const steer = outcome(ctx.steer("queued steering"));
		try {
			released.resolve();
			const failure = await first;
			assert.ok(failure instanceof AggregateError);
			assert.equal(failure.cause, binding);
			assert.deepEqual(failure.errors, [
				binding,
				...(mode === "shutdown" || mode === "both" ? [shutdown] : []),
				...(mode === "shutdown" ? [] : [disposal]),
			]);
			assert.equal(await prompt, failure);
			assert.equal(await attachment, failure);
			assert.equal(await steer, failure);
			assert.equal(await outcome(ctx.prompt("later prompt")), failure);
			assert.equal(await outcome(ctx.__ensureSession()), failure);
			assert.equal(await outcome(ctx.steer("later steer")), failure);
			assert.equal(creations, 1, "failed cleanup cannot authorize any successor creation");
			assert.equal(disposals, 1, "disposal is attempted even after shutdown rejection");
			assert.equal(retryPolicyReads, 0, "cleanup failure is never a same-model retry decision");
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts ?? [],
				[],
				"cleanup failure is not a model attempt failure",
			);
		} finally {
			released.resolve();
			await Promise.all([first, prompt, attachment, steer]);
			await ctx.__dispose();
		}
	},
);

// #3020: successful failed-binding cleanup still permits fallback with the original prompt.
test("successful binding cleanup releases ownership before fallback and preserves prompt options", async () => {
	const binding = new Error("Unknown model: primary unavailable");
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const events: string[] = [];
	const prompts: unknown[] = [];
	const options = { images: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }] };
	let creations = 0;
	const adapters = buildRuntimeAdapters(
		{},
		{
			createAgentSession: async () => {
				const attempt = ++creations;
				events.push(`create:${attempt}`);
				return {
					session: Object.assign(
						makeMockSession({
							prompt: async (text, sdkOptions) => {
								prompts.push([text, sdkOptions]);
							},
							getLastAssistantText: () => "completed",
						}).session,
						{
							bindExtensions: async () => {
								if (attempt === 1) throw binding;
							},
							extensionRunner: {
								hasHandlers: () => true,
								emit: async () => {
									events.push(`shutdown:${attempt}`);
									if (attempt === 1) {
										entered.resolve();
										await released.promise;
									}
								},
							},
							dispose: () => {
								events.push(`dispose:${attempt}`);
							},
						},
					),
				};
			},
		},
	);
	const ctx = createStageContext(
		makeOpts({ stageOptions: { model: "missing/primary", fallbackModels: ["available/fallback"] }, adapters }),
	) as InternalStageContext;
	const prompt = ctx.prompt("original prompt", options);
	await entered.promise;
	try {
		assert.deepEqual(events, ["create:1", "shutdown:1"]);
		released.resolve();
		assert.equal(await prompt, "completed");
		assert.deepEqual(events, ["create:1", "shutdown:1", "dispose:1", "create:2"]);
		assert.deepEqual(prompts, [["original prompt", options]]);
		assert.deepEqual(
			ctx.__modelFallbackMeta().modelAttempts?.map(({ model, success }) => [model, success]),
			[
				["missing/primary", false],
				["available/fallback", true],
			],
		);
	} finally {
		released.resolve();
		await prompt;
		await ctx.__dispose();
	}
});
