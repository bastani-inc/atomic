import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { SendMessagesOptions } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { StorageTransientError } from "../src/core/storage/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { detachedResult, settlesWithin, waitForCiTurn, waitTool } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const finishTools: Array<() => void> = [];
afterEach(async () => {
	for (const finish of finishTools.splice(0)) finish();
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

const stageContext = () => ({
	kind: "workflow-stage" as const,
	workflowRunId: crypto.randomUUID(),
	workflowStageId: "stage-delivery",
	workflowStageName: "Stage delivery",
	constraints: { disableWorkflowTool: true },
});

const notice = (content: string) => ({ customType: "stage-notice", content, display: true });

function cardsWith(harness: Harness, content: string): number {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.content === content).length;
}

/** A workflow stage whose only tool call detached, so it waits on that result before its turn can end. */
async function stageWaitingOnDetachedResult(
	sessionManager: SessionManager = SessionManager.inMemory(),
): Promise<Harness> {
	const tool = waitTool();
	const harness = await createHarness({
		sessionManager,
		customTools: [tool.definition],
		orchestrationContext: stageContext(),
	});
	harnesses.push(harness);
	finishTools.push(() => tool.finish(0, "green"));
	harness.session.setToolDetachment({ afterMs: 0 });
	harness.setResponses([waitForCiTurn("ci-1")]);
	await settlesWithin(harness.session.prompt("watch CI"));
	assert.equal(harness.session.takeDetachedToolCalls().length, 1);
	assert.equal(harness.session.isWaitingOnDetachedResults(), true);
	return harness;
}

async function resumesAndAcceptsLaterPrompt(harness: Harness): Promise<void> {
	harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("answered")));
	await settlesWithin(harness.session.resumeDetachedTurn([detachedResult("ci-1", "green")]));
	await settlesWithin(harness.session.prompt("a later stage task"));
}

test("two turn-starting batches sent together while a stage waits on a detached result both finish admission (#5318)", async () => {
	const harness = await stageWaitingOnDetachedResult();
	const first: SendMessagesOptions = { triggerTurn: true, stageAdmissionKey: "batch-first" };
	const second: SendMessagesOptions = { triggerTurn: true, stageAdmissionKey: "batch-second" };

	await settlesWithin(
		Promise.all([
			harness.session.sendCustomMessages([notice("first background notice")], first),
			harness.session.sendCustomMessages([notice("second background notice")], second),
		]),
	);

	assert.equal(cardsWith(harness, "first background notice"), 1);
	assert.equal(cardsWith(harness, "second background notice"), 1);
	await resumesAndAcceptsLaterPrompt(harness);
});

for (const applied of [false, true]) {
	test(`a stage's turn-starting batch retried after its card write lost its acknowledgement finishes admission (applied=${applied}) (#5318)`, async () => {
		const store = new MemorySessionStore();
		const failure = new StorageTransientError(store.descriptor, {
			code: "connection-lost",
			outcome: "unknown",
			attempts: 1,
		});
		let armed = false;
		let lost = false;
		let failReadBack = false;
		const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
			async append(...args: Parameters<SessionStore["append"]>) {
				const hit =
					armed &&
					!lost &&
					args[1].some((entry) => entry.type === "custom_message" && entry.content === "uncertain notice");
				if (!hit) return store.append(...args);
				if (applied) await store.append(...args);
				lost = true;
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
		const harness = await stageWaitingOnDetachedResult(await SessionManager.create(faulty, process.cwd()));
		armed = true;
		const options: SendMessagesOptions = { triggerTurn: true, stageAdmissionKey: "uncertain-batch" };

		await assert.rejects(
			settlesWithin(harness.session.sendCustomMessages([notice("uncertain notice")], options)),
			StorageTransientError,
		);
		await settlesWithin(harness.session.sendCustomMessages([notice("uncertain notice")], options));

		assert.equal(cardsWith(harness, "uncertain notice"), 1, "the retried card is saved once");
		await resumesAndAcceptsLaterPrompt(harness);
	});
}

test("a stage's turn-starting message whose turn cannot start is reported to its sender and stays retryable (#5318)", async () => {
	const store = new MemorySessionStore();
	let failing = false;
	const failure = new StorageTransientError(store.descriptor, {
		code: "connection-lost",
		outcome: "not-applied",
		attempts: 1,
	});
	const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			if (failing && args[1].some((entry) => entry.type === "custom_message")) throw failure;
			return store.append(...args);
		},
	});
	const harness = await createHarness({
		sessionManager: await SessionManager.create(faulty, process.cwd()),
		orchestrationContext: stageContext(),
	});
	harnesses.push(harness);
	const contexts: string[] = [];
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	harness.setResponses([
		async (context) => {
			contexts.push(JSON.stringify(context.messages));
			started.resolve();
			await gate.promise;
			return fauxAssistantMessage("first stage turn");
		},
		...Array.from({ length: 3 }, () => (context: { messages: unknown[] }) => {
			contexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("later turn");
		}),
	]);
	const firstTurn = harness.session.prompt("stage task");
	await started.promise;
	// A note left pending by this turn is flushed before the next turn starts, and cannot be saved during the outage.
	await harness.session.sendCustomMessage(notice("pending note"), { triggerTurn: false });
	failing = true;
	gate.resolve();
	await settlesWithin(firstTurn);
	await harness.session.agent.waitForIdle();
	const send = () =>
		harness.session.sendCustomMessage(notice("turn notice"), { triggerTurn: true, stageAdmissionKey: "turn-key" });

	await assert.rejects(settlesWithin(send()), StorageTransientError);
	failing = false;
	await settlesWithin(send());
	await settlesWithin(harness.session.agent.waitForIdle());

	assert.equal(cardsWith(harness, "turn notice"), 1, "the retried notice is saved once");
	assert.equal(contexts.filter((context) => context.includes("turn notice")).length, 1, "one model request sees it");
});
