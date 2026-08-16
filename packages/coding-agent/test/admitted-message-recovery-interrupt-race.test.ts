import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

describe("admitted-message recovery versus interrupt custom-message delivery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("an interrupt custom message during an admitted message's contentless reply does not reject the caller's prompt", async () => {
		const firstStreamStarted = Promise.withResolvers<void>();
		const releaseFirstStream = Promise.withResolvers<void>();
		const secondStreamStarted = Promise.withResolvers<void>();
		const secondStreamAborted = Promise.withResolvers<void>();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				firstStreamStarted.resolve();
				await releaseFirstStream.promise;
				return fauxAssistantMessage("first reply");
			},
			async (_context, options) => {
				secondStreamStarted.resolve();
				await new Promise<void>((resolve) => {
					const observe = () => {
						secondStreamAborted.resolve();
						resolve();
					};
					if (options?.signal?.aborted) observe();
					else options?.signal?.addEventListener("abort", observe, { once: true });
				});
				return fauxAssistantMessage("never emitted");
			},
			fauxAssistantMessage("interrupt reply"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		const activeTurn = harness.session.prompt("start the turn");
		await firstStreamStarted.promise;
		await harness.session.steer("QUEUED-STEER");
		releaseFirstStream.resolve();
		// The loop polls the steering queue after the first reply and admits
		// QUEUED-STEER into the transcript, then opens the request below.
		await secondStreamStarted.promise;

		const interrupt = harness.session.sendCustomMessage(
			{ customType: "extension-interrupt", content: "interrupt payload", display: true },
			{ deliverAs: "interrupt", triggerTurn: true },
		);
		await secondStreamAborted.promise;

		let promptRejection: unknown;
		await Promise.all([
			activeTurn.catch((error: unknown) => {
				promptRejection = error;
			}),
			interrupt,
		]);
		// The interrupt delivery is fire-and-forget inside sendCustomMessage, so
		// settle on the session going idle rather than on that promise.
		for (let i = 0; i < 40 && harness.session.isStreaming; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 25));

		assert.equal(
			promptRejection,
			undefined,
			`prompt() rejected: ${promptRejection instanceof Error ? promptRejection.message : String(promptRejection)}`,
		);
		assert.deepEqual(
			harness.session.messages.map((message) => `${message.role}:${getMessageText(message)}`),
			[
				"user:start the turn",
				"assistant:first reply",
				"user:QUEUED-STEER",
				"assistant:",
				"custom:interrupt payload",
				"assistant:interrupt reply",
			],
		);
		assert.equal(getMessageText(harness.session.messages[2]), "QUEUED-STEER");
	});

	// The deciding case between the two candidate gates. A bare
	// `if (session._pendingInterruptDeliveries > 0) return;` also removes the
	// rejection above, but strands the admitted message here — reintroducing #2362
	// whenever an interrupt delivery is still in flight as the pause lands. Awaiting
	// the delivery instead lets the recovery proceed once the tail is re-read.
	test("an admitted message still gets its reply when the pause lands during an interrupt delivery", async () => {
		const firstStreamStarted = Promise.withResolvers<void>();
		const releaseFirstStream = Promise.withResolvers<void>();
		const secondStreamStarted = Promise.withResolvers<void>();
		const secondStreamAborted = Promise.withResolvers<void>();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				firstStreamStarted.resolve();
				await releaseFirstStream.promise;
				return fauxAssistantMessage("first reply");
			},
			async (_context, options) => {
				secondStreamStarted.resolve();
				await new Promise<void>((resolve) => {
					const observe = () => {
						secondStreamAborted.resolve();
						resolve();
					};
					if (options?.signal?.aborted) observe();
					else options?.signal?.addEventListener("abort", observe, { once: true });
				});
				return fauxAssistantMessage("never emitted");
			},
			fauxAssistantMessage("reply to the admitted message"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		const activeTurn = harness.session.prompt("start the turn");
		await firstStreamStarted.promise;
		await harness.session.steer("QUEUED-STEER");
		releaseFirstStream.resolve();
		await secondStreamStarted.promise;

		// Enqueue the interrupt, which increments the pending count synchronously,
		// then take the pause in the same tick so the delivery joins the hold instead
		// of running its own turn. That is the window the bare skip breaks.
		void harness.session.sendCustomMessage(
			{ customType: "extension-interrupt", content: "interrupt payload", display: true },
			{ deliverAs: "interrupt", triggerTurn: true },
		);
		harness.session.pauseQueuedMessages();
		void harness.session.abort().catch(() => undefined);
		await secondStreamAborted.promise;
		await activeTurn;

		// No further user action from here on.
		for (let i = 0; i < 40 && harness.session.isStreaming; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 25));

		const roles = harness.session.messages.map((message) => `${message.role}:${getMessageText(message)}`);
		assert.ok(
			roles.includes("assistant:reply to the admitted message"),
			`the admitted message was stranded; transcript=${JSON.stringify(roles)}`,
		);
		assert.equal(harness.session.queuedMessagesPaused, true, "the pause itself must survive the recovery");
	});
});
