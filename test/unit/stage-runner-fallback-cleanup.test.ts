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
