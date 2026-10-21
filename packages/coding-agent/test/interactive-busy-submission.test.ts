import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import {
	countOf,
	createGate,
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	type Gate,
	gateOnce,
	holdTool,
	hookGate,
	isIdleAfterAnswering,
	isVisible,
	RETRY_BACKOFF_MS,
	type Rig,
	releaseOpenGates,
	sleep,
	waitFor,
} from "./helpers/busy-submission-rig.ts";
import { getAssistantTexts, getUserTexts } from "./suite/harness.ts";

function isShownOnceAsQueued(host: Rig["host"], text: string): boolean {
	const pendingLines = host.pendingMessagesContainer.render(200).filter((line) => line.includes(text));
	return pendingLines.length === 1 && countOf(host.rendered, text) === countOf(host.discarded, text);
}

function settledHandlerSends(
	gate: Gate,
	sendBeforeWaiting: boolean,
	deliverAs: "followUp" | undefined,
): ExtensionFactory {
	const wait = gateOnce(gate);
	let armed = true;
	return (pi) => {
		pi.on("agent_settled", async () => {
			if (!armed) return;
			armed = false;
			const send = () => pi.sendUserMessage("EXT", deliverAs ? { deliverAs } : undefined);
			if (sendBeforeWaiting) send();
			await wait();
			if (!sendBeforeWaiting) send();
		});
	};
}

describe.each(["local", "isolated"] as const)("interactive submissions while the agent is busy (%s host)", (wiring) => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	describe.each(["quiet", "loaded"] as const)("%s process", (load) => {
		test("messages typed while the prompt is still being prepared are visibly held and join the same run in order", async () => {
			const preflight = createGate();
			const toolHold = createGate();
			const rig = await createRig(wiring, load, {
				extensions: [hookGate("before_agent_start", preflight)],
				tools: [holdTool(toolHold)],
			});
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("reply to the first message"),
				fauxAssistantMessage("reply to the second message"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			await rig.host.defaultEditor.onSubmit?.("P1");
			await preflight.entered.promise;
			await rig.host.defaultEditor.onSubmit?.("M1");
			await rig.host.defaultEditor.onSubmit?.("M2");

			assert.equal(isVisible(rig.host, "M1"), true, "M1 is not visible while the prompt is being prepared");
			assert.equal(isVisible(rig.host, "M2"), true, "M2 is not visible while the prompt is being prepared");
			assert.deepEqual(
				rig.host.pendingUserInputs,
				[],
				"typed messages were parked where nothing shows or delivers them",
			);

			preflight.release.resolve();
			await toolHold.entered.promise;
			await waitFor("the engine to accept both messages while the run is open", () =>
				["M1", "M2"].every(
					(text) =>
						getUserTexts(rig.engine).includes(text) || rig.engine.session.getSteeringMessages().includes(text),
				),
			);
			toolHold.release.resolve();
			await waitFor("the run to answer every message", () => {
				const users = getUserTexts(rig.engine);
				return users.includes("M1") && users.includes("M2") && isIdleAfterAnswering(rig.engine);
			});

			assert.deepEqual(
				getUserTexts(rig.engine),
				["P1", "M1", "M2"],
				"submission order or exactly-once delivery was lost",
			);
			assert.equal(
				rig.engine.eventsOfType("agent_start").length,
				1,
				"the messages waited for a second run instead of joining this one",
			);
			assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
		});

		test("a message submitted in the same tick as the prompt that starts a turn is held visibly and delivered after it", async () => {
			const rig = await createRig(wiring, load, {});
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage("reply to the first message"),
				fauxAssistantMessage("reply to the second message"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			const first = rig.host.defaultEditor.onSubmit?.("P1");
			const second = rig.host.defaultEditor.onSubmit?.("P2");

			assert.equal(isVisible(rig.host, "P2"), true, "the second message is not visible");
			assert.deepEqual(rig.host.pendingUserInputs, [], "the second message was parked where nothing shows it");
			await Promise.all([first, second]);
			await waitFor("both messages to be answered", () => {
				const users = getUserTexts(rig.engine);
				return users.includes("P2") && isIdleAfterAnswering(rig.engine);
			});

			assert.deepEqual(getUserTexts(rig.engine), ["P1", "P2"], "submission order or exactly-once delivery was lost");
			assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
		});

		test("a message typed during an auto-retry backoff is visible at once and delivered exactly once", async () => {
			const rig = await createRig(wiring, load, {
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: RETRY_BACKOFF_MS } },
			});
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("recovered"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			const retryStarted = Promise.withResolvers<void>();
			rig.engine.session.subscribe((event) => {
				if (event.type === "auto_retry_start") retryStarted.resolve();
			});

			await rig.host.defaultEditor.onSubmit?.("P1");
			await retryStarted.promise;
			await rig.host.defaultEditor.onSubmit?.("M-retry");
			await waitFor("the message to be visible", () => isVisible(rig.host, "M-retry"));
			assert.deepEqual(rig.host.pendingUserInputs, [], "the message was parked where nothing shows or delivers it");

			await waitFor("the retry to answer the typed message", () =>
				getAssistantTexts(rig.engine).includes("recovered"),
			);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
			assert.equal(countOf(getUserTexts(rig.engine), "M-retry"), 1, "the message was not delivered exactly once");
			assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
		});

		test("messages typed while agent_settled handlers run are visibly queued and delivered once, in order, after them", async () => {
			const settled = createGate();
			const rig = await createRig(wiring, load, { extensions: [hookGate("agent_settled", settled)] });
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("answer to the typed messages"),
				fauxAssistantMessage("unexpected extra reply"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			await rig.host.defaultEditor.onSubmit?.("P1");
			await settled.entered.promise;
			if (wiring === "isolated") {
				await waitFor("the host to see the prompt dispatched", () => rig.host.onInputCallback !== undefined);
			}
			await rig.host.defaultEditor.onSubmit?.("M-settled-1");
			await rig.host.defaultEditor.onSubmit?.("M-settled-2");
			await waitFor("both messages to be visible while the settled handlers run", () =>
				["M-settled-1", "M-settled-2"].every((text) => isVisible(rig.host, text)),
			);
			await waitFor("each message to be shown once, as a queued entry", () =>
				["M-settled-1", "M-settled-2"].every((text) => isShownOnceAsQueued(rig.host, text)),
			);
			assert.deepEqual(rig.host.pendingUserInputs, [], "a message was parked where nothing shows or delivers it");
			assert.deepEqual(getUserTexts(rig.engine), ["P1"], "a message was delivered before the handlers finished");

			settled.release.resolve();
			await waitFor("the typed messages to be answered", () => {
				const users = getUserTexts(rig.engine);
				return users.includes("M-settled-2") && isIdleAfterAnswering(rig.engine);
			});
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

			assert.deepEqual(
				getUserTexts(rig.engine),
				["P1", "M-settled-1", "M-settled-2"],
				"submission order or exactly-once delivery was lost",
			);
			assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
		});

		test("the run that delivers a message typed while agent_settled handlers run settles like any other run", async () => {
			const settled = createGate();
			const extensionLifecycle: string[] = [];
			const recordLifecycle: ExtensionFactory = (pi) => {
				pi.on("agent_start", () => {
					extensionLifecycle.push("agent_start");
				});
				pi.on("agent_end", () => {
					extensionLifecycle.push("agent_end");
				});
				pi.on("agent_settled", () => {
					extensionLifecycle.push("agent_settled");
				});
			};
			const rig = await createRig(wiring, load, {
				extensions: [recordLifecycle, hookGate("agent_settled", settled)],
			});
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("answer to the typed message"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			await rig.host.defaultEditor.onSubmit?.("P1");
			await settled.entered.promise;
			if (wiring === "isolated") {
				await waitFor("the host to see the prompt dispatched", () => rig.host.onInputCallback !== undefined);
			}
			await rig.host.defaultEditor.onSubmit?.("M-settled");
			await waitFor("the session to queue the typed message", () =>
				rig.engine.session.getSteeringMessages().includes("M-settled"),
			);

			settled.release.resolve();
			await waitFor(
				"the delivering run to settle",
				() => rig.engine.eventsOfType("agent_settled").length >= 2 && isIdleAfterAnswering(rig.engine),
			);
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

			const expected = ["agent_start", "agent_end", "agent_settled", "agent_start", "agent_end", "agent_settled"];
			const sessionLifecycle = rig.engine.events
				.map((event) => event.type)
				.filter((type) => type === "agent_start" || type === "agent_end" || type === "agent_settled");
			assert.deepEqual(sessionLifecycle, expected, "a run started without settling");
			assert.deepEqual(extensionLifecycle, expected, "extensions did not see the delivering run settle");
			assert.deepEqual(getUserTexts(rig.engine), ["P1", "M-settled"], "order or exactly-once delivery was lost");
			assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
		});

		test("a message the session refuses while agent_settled handlers run comes back to the editor with a notice", async () => {
			const settled = createGate();
			const rig = await createRig(wiring, load, { extensions: [hookGate("agent_settled", settled)] });
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			const engineSession = rig.engine.session as typeof rig.engine.session &
				Pick<AgentSessionInternalSurface, "_queueSteer">;
			const queueSteer = engineSession._queueSteer.bind(engineSession);
			engineSession._queueSteer = async (text, images) => {
				if (text === "M-refused") throw new Error("the session refused the queued message");
				return queueSteer(text, images);
			};

			await rig.host.defaultEditor.onSubmit?.("P1");
			await settled.entered.promise;
			if (wiring === "isolated") {
				await waitFor("the host to see the prompt dispatched", () => rig.host.onInputCallback !== undefined);
			}
			await rig.host.defaultEditor.onSubmit?.("M-refused");
			await waitFor("the refusal to reach the host", () => rig.host.notices.length > 0);
			settled.release.resolve();
			await waitFor("the run to settle", () => isIdleAfterAnswering(rig.engine));
			await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

			assert.equal(rig.host.editor.getText(), "M-refused", "the refused text was not restored to the editor");
			assert.deepEqual(rig.host.notices, ["error: the session refused the queued message"]);
			assert.deepEqual(getUserTexts(rig.engine), ["P1"], "the refused message was delivered anyway");
		});

		test.each([
			{ extensionSends: "after", deliverAs: undefined, expected: ["P1", "M-settled", "EXT"] },
			{ extensionSends: "after", deliverAs: "followUp", expected: ["P1", "M-settled", "EXT"] },
			{ extensionSends: "before", deliverAs: undefined, expected: ["P1", "EXT", "M-settled"] },
			{ extensionSends: "before", deliverAs: "followUp", expected: ["P1", "EXT", "M-settled"] },
		] as const)(
			"an extension message sent from agent_settled $extensionSends the user types there (deliverAs $deliverAs) is delivered once, in order, beside it",
			async ({ extensionSends, deliverAs, expected }) => {
				const settled = createGate();
				const rig = await createRig(wiring, load, {
					extensions: [settledHandlerSends(settled, extensionSends === "before", deliverAs)],
				});
				rigs.push(rig);
				rig.engine.setResponses([
					fauxAssistantMessage("first answer"),
					fauxAssistantMessage("second answer"),
					fauxAssistantMessage("third answer"),
					fauxAssistantMessage("unexpected extra reply"),
				]);

				await rig.host.defaultEditor.onSubmit?.("P1");
				await settled.entered.promise;
				if (wiring === "isolated") {
					await waitFor("the host to see the prompt dispatched", () => rig.host.onInputCallback !== undefined);
				}
				await rig.host.defaultEditor.onSubmit?.("M-settled");
				await waitFor("the typed message to be visible while the settled handlers run", () =>
					isVisible(rig.host, "M-settled"),
				);
				await waitFor("the session to queue the typed message", () =>
					rig.engine.session.getSteeringMessages().includes("M-settled"),
				);

				settled.release.resolve();
				await waitFor("both messages to be answered", () => {
					const users = getUserTexts(rig.engine);
					return users.includes("M-settled") && users.includes("EXT") && isIdleAfterAnswering(rig.engine);
				});
				await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

				assert.deepEqual(getUserTexts(rig.engine), expected, "order or exactly-once delivery was lost");
				assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
			},
		);
	});
});

describe.each(["quiet", "loaded"] as const)("isolated host, %s process", (load) => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	test("a message typed after the prompt was dispatched is queued even if the host has not seen the turn start", async () => {
		const turnStart = createGate();
		const firstReply = createGate();
		const holdFirstReply = gateOnce(firstReply);
		const rig = await createRig("isolated", load, { extensions: [hookGate("agent_start", turnStart)] });
		rigs.push(rig);
		rig.engine.setResponses([
			async () => {
				await holdFirstReply();
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("answer to the typed message"),
		]);
		const pair = rig.pair;
		assert.ok(pair);

		await rig.host.defaultEditor.onSubmit?.("P1");
		await turnStart.entered.promise;
		await waitFor("the host input loop to wait for input again", () => rig.host.onInputCallback !== undefined);
		assert.equal(pair.runtime.session.isStreaming, false, "the host already knows the turn started");
		assert.equal(rig.engine.session.isStreaming, true, "the engine is not running the turn");

		await rig.host.defaultEditor.onSubmit?.("M-stale");
		await waitFor("the engine to accept or refuse the typed message", () => {
			const queued = rig.engine.session.getSteeringMessages().includes("M-stale");
			return queued || getUserTexts(rig.engine).includes("M-stale") || rig.host.notices.length > 0;
		});
		await waitFor("the typed message to be shown once, as a queued entry", () =>
			isShownOnceAsQueued(rig.host, "M-stale"),
		);
		turnStart.release.resolve();
		firstReply.release.resolve();
		await waitFor("the typed message to be answered", () =>
			getAssistantTexts(rig.engine).includes("answer to the typed message"),
		);

		assert.equal(countOf(getUserTexts(rig.engine), "M-stale"), 1, "the typed message was not delivered exactly once");
		assert.deepEqual(rig.host.notices, [], "the busy engine rejected the message");
	});

	test("a queued batch is delivered in order even when its first prompt finishes before the rest is queued", async () => {
		const rig = await createRig("isolated", load, {});
		rigs.push(rig);
		rig.engine.setResponses(Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`reply ${index + 1}`)));
		rig.host.compactionQueuedMessages = [
			{ text: "C1", mode: "steer" },
			{ text: "C2", mode: "steer" },
			{ text: "C3", mode: "followUp" },
		];

		await rig.host.flushCompactionQueue({ willRetry: false });
		await waitFor("every queued message to be delivered", () => getUserTexts(rig.engine).length === 3);
		await waitFor("the engine to go idle", () => isIdleAfterAnswering(rig.engine));

		assert.deepEqual(getUserTexts(rig.engine), ["C1", "C2", "C3"]);
		assert.deepEqual(rig.engine.session.getSteeringMessages(), []);
		assert.deepEqual(rig.engine.session.getFollowUpMessages(), []);
		assert.deepEqual(rig.host.notices, []);
	});
});

describe("a submission the session refuses while a turn is in flight", () => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	function refuseText(rig: Rig, refused: string, error: Error): () => number {
		const originalPrompt = rig.host.session.prompt.bind(rig.host.session);
		let refusals = 0;
		rig.host.session.prompt = async (text, options) => {
			if (text !== refused) return originalPrompt(text, options);
			refusals += 1;
			throw error;
		};
		return () => refusals;
	}

	test("typed while the agent is streaming comes back to the editor with a notice", async () => {
		const toolHold = createGate();
		const rig = await createRig("local", "quiet", { tools: [holdTool(toolHold)] });
		rigs.push(rig);
		rig.engine.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);
		const refusals = refuseText(rig, "M-refused", new Error("provider rejected the queued message"));

		await rig.host.defaultEditor.onSubmit?.("P1");
		await toolHold.entered.promise;
		await rig.host.defaultEditor.onSubmit?.("M-refused");
		toolHold.release.resolve();
		await waitFor("the run to finish", () => getAssistantTexts(rig.engine).includes("final answer"));

		assert.equal(refusals(), 1);
		assert.equal(rig.host.editor.getText(), "M-refused", "the refused text was not restored to the editor");
		assert.deepEqual(rig.host.notices, ["error: provider rejected the queued message"]);
	});

	test("held behind a prompt that is still being prepared stays queued and visible with a notice", async () => {
		const preflight = createGate();
		const rig = await createRig("local", "quiet", { extensions: [hookGate("before_agent_start", preflight)] });
		rigs.push(rig);
		rig.engine.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("unexpected extra reply")]);
		const refusals = refuseText(rig, "M-refused", new Error("provider rejected the held message"));

		await rig.host.defaultEditor.onSubmit?.("P1");
		await preflight.entered.promise;
		await rig.host.defaultEditor.onSubmit?.("M-refused");
		preflight.release.resolve();
		await waitFor("the held message to be refused", () => refusals() === 1 && rig.host.notices.length > 0);

		assert.deepEqual(rig.host.compactionQueuedMessages, [{ text: "M-refused", mode: "steer" }]);
		assert.equal(isVisible(rig.host, "M-refused"), true, "the refused message is no longer visible");
		assert.deepEqual(rig.host.notices, ["error: Failed to send queued message: provider rejected the held message"]);
		assert.deepEqual(rig.host.discarded, ["M-refused"], "the echo of the refused message was left in the transcript");
		await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
		assert.deepEqual(getUserTexts(rig.engine), ["P1"]);
	});
});
