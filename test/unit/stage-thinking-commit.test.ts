import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

test("stage thinking writes remain pending until commit and preserve the store rejection", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const failure = new SessionConflictError("session", 1, 2);
	let reject = false;
	const mock = makeMockSession({
		async setThinkingLevel() {
			entered.resolve();
			await release.promise;
			if (reject) throw failure;
		},
	});
	const context = createStageContext(makeOpts({ adapters: { agentSession: { create: async () => mock.session } } }));
	await context.__ensureSession();
	let settled = false;
	const pending = context.setThinkingLevel("high").then(() => {
		settled = true;
	});
	await entered.promise;
	assert.equal(settled, false);
	release.resolve();
	await pending;
	assert.equal(settled, true);
	reject = true;
	await assert.rejects(context.setThinkingLevel("low"), (error) => error === failure);
	await context.__dispose();
});

test("a pending thinking selection commits before stage readiness and prompt dispatch", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls: string[] = [];
	const mock = makeMockSession({
		async setThinkingLevel() {
			entered.resolve();
			await release.promise;
			calls.push("committed");
		},
		async prompt() {
			calls.push("prompt");
			return "done";
		},
	});
	const context = createStageContext(
		makeOpts({
			adapters: { agentSession: { create: async () => mock.session } },
			onSessionReady: () => {
				calls.push("ready");
			},
		}),
	);
	await context.setThinkingLevel("high");
	const pending = context.prompt("go");
	await entered.promise;
	assert.deepEqual(calls, []);
	release.resolve();
	assert.equal(await pending, "ok");
	assert.deepEqual(calls, ["committed", "ready", "prompt"]);
	await context.__dispose();
});
