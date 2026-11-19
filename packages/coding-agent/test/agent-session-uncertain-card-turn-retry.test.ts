import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { StorageTransientError } from "../src/core/storage/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createHarness, type Harness } from "./suite/harness.js";

const original = { customType: "uncertain-turn-card", content: "original uncertain input", display: true };
const intervening = { customType: "intervening-turn-card", content: "intervening saved input", display: true };
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

async function uncertainHarness(applied = true): Promise<{
	harness: Harness;
	store: MemorySessionStore;
	failure: StorageTransientError;
}> {
	const store = new MemorySessionStore();
	const failure = new StorageTransientError(store.descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
	});
	let lostAcknowledgement = false;
	let failReadBack = false;
	const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			const loseAcknowledgement =
				!lostAcknowledgement &&
				args[1].some((entry) => entry.type === "custom_message" && entry.content === original.content);
			if (!loseAcknowledgement) return store.append(...args);
			if (applied) await store.append(...args);
			lostAcknowledgement = true;
			failReadBack = true;
			throw failure;
		},
		async readRange(...args: Parameters<SessionStore["readRange"]>) {
			if (failReadBack) {
				failReadBack = false;
				throw failure;
			}
			return store.readRange(...args);
		},
	});
	const manager = await SessionManager.create(faulty, process.cwd());
	const harness = await createHarness({
		sessionManager: manager,
	});
	harnesses.push(harness);
	return { harness, store, failure };
}

async function assertSavedOnce(harness: Harness, store: MemorySessionStore): Promise<void> {
	const reopened = await SessionManager.open(store, harness.sessionManager.getSessionId());
	for (const manager of [harness.sessionManager, reopened]) {
		for (const entries of [manager.getEntries(), manager.getBranch()]) {
			assert.equal(
				entries.filter((entry) => entry.type === "custom_message" && entry.content === original.content).length,
				1,
				"the original card is saved once in memory and storage",
			);
		}
	}
	for (const type of ["message_start", "message_end"] as const) {
		assert.equal(
			harness
				.eventsOfType(type)
				.filter((event) => event.message.role === "custom" && event.message.content === original.content).length,
			1,
			"the recovered card is displayed once",
		);
	}
}

test.each([undefined, false])(
	"an uncertain ordinary batch retried while streaming keeps one input with triggerTurn=%s (#5318)",
	async (triggerTurn) => {
		const { harness, store, failure } = await uncertainHarness();
		const options = { triggerTurn, stageAdmissionKey: "uncertain-ordinary-key" };
		await assert.rejects(harness.session.sendCustomMessages([original], options), (error) => error === failure);
		await harness.session.sendCustomMessage(intervening, { stageAdmissionKey: "intervening-key" });
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const contexts: string[] = [];
		harness.setResponses([
			async (context) => {
				contexts.push(JSON.stringify(context.messages));
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage("completed the existing turn");
			},
			...Array.from({ length: 4 }, () => (context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("inspected the saved context");
			}),
		]);
		const turn = harness.session.prompt("perform the task with admitted input");
		try {
			await started.promise;
			await harness.session.sendCustomMessages([original], options);
		} finally {
			finish.resolve();
			await turn;
		}
		await harness.session.prompt("inspect the saved context");
		assert.equal(contexts.length, 2, "the retry starts no extra turn after the streaming response");
		for (const context of contexts) assert.equal(context.split(original.content).length - 1, 1);
		await assertSavedOnce(harness, store);
	},
);

test("an excluded batch saved while streaming is not displayed again when retried while paused (#5318)", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const contexts: string[] = [];
	harness.setResponses([
		async (context) => {
			contexts.push(JSON.stringify(context.messages));
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage("completed the existing turn");
		},
		(context) => {
			contexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("verified excluded input stays out of context");
		},
	]);
	const turn = harness.session.prompt("perform the original task");
	try {
		await started.promise;
		const options = { excludeFromContext: true, stageAdmissionKey: "excluded-during-turn" };
		await harness.session.sendCustomMessages([original], options);
		harness.session.pauseQueuedMessages();
		await harness.session.sendCustomMessages([original], { ...options, triggerTurn: true });
		assert.equal(harness.session.pendingMessageCount, 0);
		assert.equal(await harness.session.resumeQueuedMessages(), false);
	} finally {
		finish.resolve();
		await turn;
	}
	await harness.session.prompt("inspect the context without display-only input");
	assert.equal(contexts.length, 2);
	for (const context of contexts) assert.equal(context.includes(original.content), false);
	assert.equal(
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.content === original.content).length,
		1,
	);
	for (const type of ["message_start", "message_end"] as const) {
		assert.equal(
			harness
				.eventsOfType(type)
				.filter((event) => event.message.role === "custom" && event.message.content === original.content).length,
			1,
			"a card emitted during the turn remains displayed when retried while paused",
		);
	}
});

test.each([
	{ form: "single", excluded: false, applied: true },
	{ form: "batch", excluded: false, applied: true },
	{ form: "single", excluded: true, applied: true },
	{ form: "batch", excluded: true, applied: true },
	{ form: "single", excluded: false, applied: false },
	{ form: "batch", excluded: false, applied: false },
	{ form: "single", excluded: true, applied: false },
	{ form: "batch", excluded: true, applied: false },
] as const)(
	"concurrent uncertain $form retries save one card with excluded=$excluded and applied=$applied (#5318)",
	async ({ form, excluded, applied }) => {
		const { harness, store, failure } = await uncertainHarness(applied);
		const options = { stageAdmissionKey: "concurrent-uncertain-key", excludeFromContext: excluded };
		const send = () =>
			form === "single"
				? harness.session.sendCustomMessage(original, options)
				: harness.session.sendCustomMessages([original], options);
		await assert.rejects(send(), (error) => error === failure);
		await harness.session.sendCustomMessage(intervening, { stageAdmissionKey: "intervening-key" });
		await Promise.all([send(), send()]);
		const contexts: string[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("completed after concurrent recovery");
			},
		]);
		await harness.session.prompt("inspect the recovered context");
		assert.equal(contexts.length, 1);
		assert.equal(contexts[0]!.split(original.content).length - 1, excluded ? 0 : 1);
		await assertSavedOnce(harness, store);
	},
);
