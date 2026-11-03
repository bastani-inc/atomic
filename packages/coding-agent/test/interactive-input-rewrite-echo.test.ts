import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import {
	createGate,
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	type Gate,
	holdTool,
	isIdleAfterAnswering,
	type Rig,
	type RigOptions,
	releaseOpenGates,
	sleep,
	type Wiring,
	waitFor,
} from "./helpers/busy-submission-rig.js";
import { pressAltEnter, pressAltUp, showUserMessagesInChat } from "./helpers/interactive-submission-host.js";
import { getUserTexts } from "./suite/harness.js";

/** An `input` hook that rewrites every message before it is sent. */
const rewriteInput: ExtensionFactory = (pi) => {
	pi.on("input", (event) => ({ action: "transform", text: `${event.text} (rewritten)` }));
};

const rewritten = (text: string): string => `${text} (rewritten)`;

const rigs: Rig[] = [];
const heldCompactions: Array<() => void> = [];
afterEach(async () => {
	for (const release of heldCompactions.splice(0)) release();
	releaseOpenGates();
	while (rigs.length > 0) await rigs.pop()?.stop();
	vi.restoreAllMocks();
});

async function createRewritingRig(
	wiring: Wiring,
	options: Omit<RigOptions, "extensions"> = {},
): Promise<{ rig: Rig; chat: () => string[] }> {
	const rig = await createRig(wiring, "quiet", { ...options, extensions: [rewriteInput] });
	rigs.push(rig);
	const chat = showUserMessagesInChat(rig.host);
	if (rig.pair) await rig.pair.runtime.waitUntilResourcesReady();
	return { rig, chat };
}

async function settle(rig: Rig): Promise<void> {
	if (rig.pair) await rig.pair.drain();
	await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
}

/** The model got each message once, as rewritten, and the chat shows exactly those messages, once each. */
function assertShownOnceAsSent(rig: Rig, chat: () => string[], sent: string[], expectedNotices: string[] = []): void {
	assert.deepEqual(getUserTexts(rig.engine), sent, "the model must get each message once, as rewritten");
	assert.deepEqual(chat(), sent, "the chat must show each message once, as it was sent");
	assert.deepEqual(
		Reflect.get(rig.host, "deferredRenderedUserInputs"),
		[],
		"no echo of a typed message may be left to show again when the chat is redrawn",
	);
	assert.deepEqual(rig.host.notices, expectedNotices, "a notice was shown for an accepted message");
}

/** Route compaction events through InteractiveMode's own handler, so the host holds what is typed meanwhile. */
function followCompaction(rig: Rig): void {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: { type: string },
	) => Promise<void>;
	Object.assign(rig.host, {
		manualCompactionTakeoverPending: false,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandlerSaved: false,
		statusContainer: new Container(),
	});
	Object.assign(rig.host.settingsManager, { getShowTerminalProgress: () => false, getClearOnShrink: () => false });
	Object.assign(rig.host.ui, { terminal: { setProgress() {} } });
	Object.defineProperty(rig.host, "compactionActive", {
		configurable: true,
		get: () => rig.host.session.isCompacting || Reflect.get(rig.host, "manualCompactionTakeoverPending") === true,
	});
	rig.host.session.subscribe(async (event) => {
		if (event.type === "compaction_start" || event.type === "compaction_end") await handleEvent.call(rig.host, event);
	});
}

function holdCompaction(rig: Rig): () => void {
	const release = Promise.withResolvers<undefined>();
	vi.spyOn(
		rig.engine.session as unknown as { _applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined> },
		"_applyVerbatimCompaction",
	).mockImplementation(() => release.promise);
	const releaseCompaction = () => release.resolve(undefined);
	heldCompactions.push(releaseCompaction);
	return releaseCompaction;
}

describe.each(["local", "isolated"] as const)("a message an input hook rewrites (%s host)", (wiring) => {
	test("sent with Enter is shown once, as it was sent (#4277)", async () => {
		const { rig, chat } = await createRewritingRig(wiring);
		rig.engine.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unexpected extra reply")]);

		await rig.host.defaultEditor.onSubmit?.("hello");
		await waitFor(
			"the message to be answered",
			() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
		);
		await settle(rig);

		assertShownOnceAsSent(rig, chat, [rewritten("hello")]);
	});

	if (wiring === "isolated") {
		test("sent with Enter, its answer read together with the turn's first events, is shown once (#4277)", async () => {
			const { rig, chat } = await createRewritingRig(wiring);
			rig.engine.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unexpected extra reply")]);
			// The session shows the message before the host learns that the prompt started a turn.
			const pair = rig.pair;
			assert.ok(pair);
			pair.holdHostTrafficFrom((record) => record.type === "response" && record.command === "prompt");

			await rig.host.defaultEditor.onSubmit?.("hello");
			await waitFor(
				"the message to be answered",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await pair.releaseHostTraffic();
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("hello")]);
		});
	}

	test.each(["Enter", "Alt+Enter"] as const)(
		"sent with %s as the turn ends is shown once, as it was sent (#4277)",
		async (key) => {
			const { rig, chat } = await createRewritingRig(wiring);
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("answer to the message"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			const message = "sent as the turn ends";
			const submit = (): Promise<void> =>
				key === "Enter"
					? Promise.resolve(rig.host.defaultEditor.onSubmit?.(message))
					: pressAltEnter(rig.host, message);
			let submitted: Promise<void> | undefined;

			if (rig.pair) {
				// The host still shows the turn running, so the message takes the path of one typed during a turn, and
				// it reads the engine's answer to it together with the first events of the turn it started (#4272).
				rig.pair.holdHostTrafficFrom((record) => record.type === "agent_end");
				await rig.host.defaultEditor.onSubmit?.("first question");
				await waitFor(
					"the engine to settle the turn",
					() => rig.engine.eventsOfType("agent_settled").length === 1 && isIdleAfterAnswering(rig.engine),
				);
				await rig.pair.drain();
				assert.equal(rig.host.session.isStreaming, true, "the host must not have seen the turn end yet");
				submitted = submit();
				await waitFor(
					"the engine to answer the message",
					() => getUserTexts(rig.engine).includes(rewritten(message)) && isIdleAfterAnswering(rig.engine),
				);
				await rig.pair.releaseHostTraffic();
			} else {
				rig.host.session.subscribe((event) => {
					if (event.type === "agent_end" && submitted === undefined) {
						setImmediate(() => {
							submitted = submit();
						});
					}
				});
				await rig.host.defaultEditor.onSubmit?.("first question");
				await waitFor(
					"the message to be answered",
					() => getUserTexts(rig.engine).includes(rewritten(message)) && isIdleAfterAnswering(rig.engine),
				);
			}
			await submitted;
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("first question"), rewritten(message)]);
		},
	);

	test("typed with Enter and Alt+Enter while the agent works is shown once each, in order (#4277)", async () => {
		const toolHold = createGate();
		const { rig, chat } = await createRewritingRig(wiring, { tools: [holdTool(toolHold)] });
		rig.engine.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("answer to everything"),
			fauxAssistantMessage("answer to the follow-up"),
			fauxAssistantMessage("unexpected extra reply"),
		]);

		await rig.host.defaultEditor.onSubmit?.("first");
		await toolHold.entered.promise;
		await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
		await rig.host.defaultEditor.onSubmit?.("steered");
		await pressAltEnter(rig.host, "followed up");
		await waitFor(
			"the session to queue both messages",
			() =>
				rig.engine.session.getSteeringMessages().length === 1 &&
				rig.engine.session.getFollowUpMessages().length === 1,
		);
		toolHold.release.resolve();
		await waitFor(
			"every message to be answered",
			() => getUserTexts(rig.engine).length === 3 && isIdleAfterAnswering(rig.engine),
		);
		await settle(rig);

		assertShownOnceAsSent(rig, chat, [rewritten("first"), rewritten("steered"), rewritten("followed up")]);
	});

	test("held during compaction is shown once, as it was sent (#4277)", async () => {
		const { rig, chat } = await createRewritingRig(wiring);
		rig.engine.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unexpected extra reply")]);
		followCompaction(rig);
		const releaseCompaction = holdCompaction(rig);
		const compaction = rig.host.session.compact().catch((error: Error) => error);
		await waitFor("the host to observe compaction", () => rig.host.session.isCompacting);

		await rig.host.defaultEditor.onSubmit?.("typed during compaction");
		assert.deepEqual(rig.host.compactionQueuedMessages, [{ text: "typed during compaction", mode: "steer" }]);
		releaseCompaction();
		await compaction;
		await waitFor(
			"the held message to be answered",
			() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
		);
		await settle(rig);

		// The held compaction found nothing to compact; that notice is not about the message.
		assertShownOnceAsSent(
			rig,
			chat,
			[rewritten("typed during compaction")],
			[
				"status: Queued message for after compaction",
				"error: Compaction failed: Nothing to compact (session too small)",
			],
		);
	});

	test.each(["Enter", "Alt+Enter"] as const)(
		"queued with %s, restored with Alt+Up as typed and sent again, is rewritten once and shown once (#4277, #4284)",
		async (key) => {
			const toolHold = createGate();
			const { rig, chat } = await createRewritingRig(wiring, { tools: [holdTool(toolHold)] });
			rig.engine.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("answer to the restored message"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			const queuedIn = (session: {
				getSteeringMessages(): readonly string[];
				getFollowUpMessages(): readonly string[];
			}) => (key === "Enter" ? session.getSteeringMessages() : session.getFollowUpMessages());

			await rig.host.defaultEditor.onSubmit?.("first");
			await toolHold.entered.promise;
			await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
			if (key === "Enter") await rig.host.defaultEditor.onSubmit?.("queued");
			else await pressAltEnter(rig.host, "queued");
			await waitFor("the session to queue the message", () => queuedIn(rig.engine.session).length === 1);
			assert.deepEqual(queuedIn(rig.engine.session), [rewritten("queued")]);
			await waitFor("the host to list the queued message", () => {
				const queued = rig.host.getAllQueuedMessages();
				return queued.steering.length + queued.followUp.length === 1;
			});
			pressAltUp(rig.host);
			await waitFor("the queued message to return to the editor", () => rig.host.editor.getText() !== "");
			await waitFor("the session to give the message back", () => queuedIn(rig.engine.session).length === 0);
			toolHold.release.resolve();
			await waitFor(
				"the turn to finish",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			const restored = rig.host.editor.getText();
			assert.equal(restored, "queued", "Alt+Up must restore the text that was typed, not the hook's output");
			rig.host.editor.setText("");
			await rig.host.defaultEditor.onSubmit?.(restored);
			await waitFor(
				"the restored message to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("first"), rewritten("queued")]);
		},
	);
});

/**
 * An `input` hook that handles every message starting with "handled:" itself, so none of them reaches the model. It
 * holds the message "slow" until `slow` is released, so a test can type while the host waits for it to be dispatched.
 */
function handleInput(slow?: Gate): ExtensionFactory {
	return (pi) => {
		pi.on("input", async (event) => {
			if (event.text.startsWith("handled:")) return { action: "handled" };
			if (event.text === "slow" && slow) {
				slow.entered.resolve();
				await slow.release.promise;
			}
			return { action: "continue" };
		});
	};
}

async function createHandlingRig(
	wiring: Wiring,
	options: Omit<RigOptions, "extensions"> & { slow?: Gate } = {},
): Promise<{ rig: Rig; chat: () => string[] }> {
	const rig = await createRig(wiring, "quiet", { ...options, extensions: [handleInput(options.slow)] });
	rigs.push(rig);
	const chat = showUserMessagesInChat(rig.host);
	if (rig.pair) await rig.pair.runtime.waitUntilResourcesReady();
	return { rig, chat };
}

describe.each(["local", "isolated"] as const)("a message an input hook handles (%s host)", (wiring) => {
	test.each(["Enter", "Alt+Enter"] as const)(
		"sent with %s while idle leaves no echo in the chat (#4285)",
		async (key) => {
			const { rig, chat } = await createHandlingRig(wiring);
			rig.engine.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unexpected extra reply")]);

			if (key === "Enter") await rig.host.defaultEditor.onSubmit?.("handled: idle");
			else await pressAltEnter(rig.host, "handled: idle");
			await waitFor("the hook to handle the message", () => rig.host.promptTurn === undefined);
			await settle(rig);
			assert.deepEqual(chat(), [], "the chat must not show a message the hook handled");

			// The next message takes its own place in the chat, not one the handled message left.
			await rig.host.defaultEditor.onSubmit?.("hello");
			await waitFor(
				"the message to be answered",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["hello"]);
		},
	);

	test.each(["Enter", "Alt+Enter"] as const)(
		"sent with %s while the agent works leaves no echo in the chat (#4285)",
		async (key) => {
			const toolHold = createGate();
			const { rig, chat } = await createHandlingRig(wiring, { tools: [holdTool(toolHold)] });
			rig.engine.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			await rig.host.defaultEditor.onSubmit?.("first");
			await toolHold.entered.promise;
			await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
			if (key === "Enter") await rig.host.defaultEditor.onSubmit?.("handled: while working");
			else await pressAltEnter(rig.host, "handled: while working");
			toolHold.release.resolve();
			await waitFor(
				"the turn to finish",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["first"]);
		},
	);

	test("typed while the host waits for a prompt to be dispatched leaves no echo in the chat (#4285)", async () => {
		const slow = createGate();
		const { rig, chat } = await createHandlingRig(wiring, { slow });
		rig.engine.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("unexpected extra reply")]);

		await rig.host.defaultEditor.onSubmit?.("slow");
		await slow.entered.promise;
		await rig.host.defaultEditor.onSubmit?.("handled: held");
		assert.deepEqual(rig.host.compactionQueuedMessages, [{ text: "handled: held", mode: "steer" }]);
		slow.release.resolve();
		await waitFor(
			"the prompt to be answered and the held message sent",
			() =>
				getUserTexts(rig.engine).length === 1 &&
				isIdleAfterAnswering(rig.engine) &&
				rig.host.compactionQueuedMessages.length === 0 &&
				!rig.host.compactionFlushPending,
		);
		await settle(rig);

		assertShownOnceAsSent(rig, chat, ["slow"]);
	});
});
