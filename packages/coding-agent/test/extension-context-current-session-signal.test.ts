import assert from "node:assert/strict";
import { test } from "vitest";
import { createHarness } from "./suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

async function createReloadHarness(prepareReload: () => Promise<never>) {
	const loader = createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([]) });
	loader.prepareReload = prepareReload;
	return createHarness({ resourceLoader: loader });
}

test("a reload the host rejects leaves a retained context's sessionSignal aborted but its current session signal live (#3742)", async () => {
	const harness = await createReloadHarness(async () => {
		throw new Error("candidate rejected");
	});
	try {
		await harness.session.bindExtensions({});
		const ctx = harness.session.extensionRunner.createContext();
		assert.equal(ctx.getCurrentSessionSignal?.().aborted, false);

		await assert.rejects(harness.session.reload(), /candidate rejected/);

		assert.equal(ctx.sessionSignal.aborted, true, "reload aborts the signal the context was created with");
		assert.equal(ctx.getCurrentSessionSignal?.().aborted, false, "the rejected reload left the session alive");

		await harness.session.dispose();

		assert.equal(ctx.getCurrentSessionSignal?.().aborted, true, "disposal ends the session's current lifetime");
	} finally {
		await harness.cleanup();
	}
});

test("a session disposed while a reload is still draining keeps its current session signal aborted (#3742)", async () => {
	const harness = await createReloadHarness(async () => {
		throw new Error("candidate rejected");
	});
	try {
		await harness.session.bindExtensions({});
		const ctx = harness.session.extensionRunner.createContext();
		const draining = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const closeSessionTasks = harness.session.closeSessionTasks.bind(harness.session);
		harness.session.closeSessionTasks = async () => {
			draining.resolve();
			await released.promise;
			return closeSessionTasks();
		};
		const reload = harness.session.reload().then(
			() => undefined,
			(error: unknown) => error,
		);
		await draining.promise;

		const disposal = harness.session.dispose();
		released.resolve();
		await reload;
		await disposal;

		assert.equal(
			ctx.getCurrentSessionSignal?.().aborted,
			true,
			"reload must not revive a disposed session's lifetime",
		);
	} finally {
		await harness.cleanup();
	}
});
