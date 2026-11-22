import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Container } from "@bastani/atomic-tui";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
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
import {
	type ChatRowsView,
	pressAltEnter,
	pressAltUp,
	showUserMessagesInChat,
} from "./helpers/interactive-submission-host.js";
import { getUserTexts } from "./suite/harness.js";

/** An `input` hook that rewrites every message before it is sent. */
const rewriteInput: ExtensionFactory = (atomic) => {
	atomic.on("input", (event) => ({ action: "transform", text: `${event.text} (rewritten)` }));
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
): Promise<{ rig: Rig; chat: ChatRowsView }> {
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

test("two sends of the same text whose runs both started before either showed its message replace their own echoes", async () => {
	const { rig, chat } = await createRewritingRig("local");
	const mode = rig.host as unknown as InteractiveModeBase;
	// The host read both sends' answers ("started") before either run's message, as when a compaction holds events.
	const first = mode.renderDeferredUserInput("hello");
	const second = mode.renderDeferredUserInput("hello");
	mode.expectStartedUserInput("hello", 0, first);
	mode.expectStartedUserInput("hello", 0, second);
	for (const _run of [first, second])
		mode.showSessionUserMessage({ role: "user", content: rewritten("hello"), timestamp: Date.now() });

	assert.deepEqual(chat(), [rewritten("hello"), rewritten("hello")], "each run's message took its own echo's place");
	assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);
});

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

	if (wiring === "isolated") {
		test("sent twice with the same text while the first run prepares, is shown once each, as sent", async () => {
			const preparing = createGate();
			const shown = createGate();
			const holdFirstRun: ExtensionFactory = (atomic) => {
				let prepare = true;
				let show = true;
				atomic.on("before_agent_start", async () => {
					if (!prepare) return;
					prepare = false;
					preparing.entered.resolve();
					await preparing.release.promise;
				});
				atomic.on("message_start", async (event) => {
					if (event.message.role !== "user" || !show) return;
					show = false;
					shown.entered.resolve();
					await shown.release.promise;
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [rewriteInput, holdFirstRun] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			await rig.pair?.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			const first = rig.host.defaultEditor.onSubmit?.("hello");
			await preparing.entered.promise;
			// The host holds the second until the first is answered, then sends it while the first run is under way.
			const second = rig.host.defaultEditor.onSubmit?.("hello");
			await waitFor("the host to hold the second message", () => rig.host.compactionQueuedMessages.length === 1);
			preparing.release.resolve();
			await shown.entered.promise;
			await waitFor(
				"the session to queue the second message",
				() => rig.engine.session.getSteeringMessages().length === 1,
			);
			await settle(rig);
			shown.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("hello"), rewritten("hello")]);
		});

		test("rewritten send 1 whose output equals send 2's literal echo replaces its own echo and keeps send 2's echo", async () => {
			const firstReply = createGate();
			const { rig, chat } = await createRewritingRig(wiring);
			const pair = rig.pair;
			assert.ok(pair);
			rig.engine.setResponses([
				async () => {
					firstReply.entered.resolve();
					await firstReply.release.promise;
					return fauxAssistantMessage("first answer");
				},
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			// Hold host traffic from agent_start so send 1's answer clears promptTurn while send 1's message_start is still buffered.
			pair.holdHostTrafficFrom((record) => record.type === "agent_start");

			const first = rig.host.defaultEditor.onSubmit?.("hello");
			await waitFor(
				"first prompt answered and turn waiting in model while host events are held",
				() => rig.host.promptTurn === undefined && firstReply.entered.promise !== undefined,
			);
			await firstReply.entered.promise;
			// Send 2's literal text equals send 1's rewrite; its echo is drawn before send 1's message_start reaches the chat.
			const second = rig.host.defaultEditor.onSubmit?.(rewritten("hello"));
			await waitFor("both echoes drawn before send 1's message_start reaches the chat", () => chat().length === 2);
			assert.deepEqual(chat(), ["hello", rewritten("hello")]);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), ["hello", rewritten("hello")]);

			// Release traffic while send 1 is still waiting for its assistant reply (and send 2 is queued behind it):
			// send 1's message_start must replace send 1's echo ("hello"), NOT steal send 2's echo ("hello (rewritten)")!
			await pair.releaseHostTraffic();
			await waitFor("send 2 to be queued in engine", () => rig.engine.session.getSteeringMessages().length === 1);
			await pair.drain();
			assert.deepEqual(
				chat(),
				[rewritten("hello")],
				"send 1 must replace its own echo at row 0 and queued send 2's echo must be discarded",
			);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);
			firstReply.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("hello"), rewritten(rewritten("hello"))]);
		});

		test("rewritten send 1 keeps its own echo across a chat rebuild when send 2's literal echo equals send 1's rewrite", async () => {
			const firstReply = createGate();
			const { rig, chat } = await createRewritingRig(wiring);
			const pair = rig.pair;
			assert.ok(pair);
			rig.engine.setResponses([
				async () => {
					firstReply.entered.resolve();
					await firstReply.release.promise;
					return fauxAssistantMessage("first answer");
				},
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			pair.holdHostTrafficFrom((record) => record.type === "agent_start");

			const first = rig.host.defaultEditor.onSubmit?.("hello");
			await firstReply.entered.promise;
			await waitFor("promptTurn cleared", () => rig.host.promptTurn === undefined);
			const second = rig.host.defaultEditor.onSubmit?.(rewritten("hello"));
			await waitFor("both echoes drawn", () => chat().length === 2);

			// Simulate a mid-flight chat rebuild (e.g., compaction or expansion toggle) while both echoes are pending.
			const mode = rig.host as unknown as InteractiveModeBase & {
				pendingTools: Map<string, unknown>;
				toolOutputExpanded: boolean;
				hideThinkingBlock: boolean;
				sessionManager: unknown;
				attachStartupNoticesContainer: () => void;
				resetTranscriptSelection: () => void;
				rebuildChatFromMessages: () => void;
				renderSessionEntries: () => void;
			};
			Object.assign(rig.host.settingsManager, {
				getShowCacheMissNotices: () => false,
				isProjectTrusted: () => true,
			});
			Object.assign(mode, {
				pendingTools: new Map(),
				toolOutputExpanded: false,
				hideThinkingBlock: false,
				sessionManager: pair.hostHarness.session.sessionManager,
				attachStartupNoticesContainer: () => {},
				resetTranscriptSelection: () => {},
				renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
				rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			});
			mode.rebuildChatFromMessages();
			assert.deepEqual(chat(), ["hello", rewritten("hello")], "both echoes survive rebuild in order");

			await pair.releaseHostTraffic();
			await waitFor("send 2 to be queued in engine", () => rig.engine.session.getSteeringMessages().length === 1);
			await pair.drain();
			assert.deepEqual(
				chat(),
				[rewritten("hello")],
				"send 1 must replace its own echo after rebuild, not steal send 2's echo",
			);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);
			firstReply.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, [rewritten("hello"), rewritten(rewritten("hello"))]);
		});

		test("a no-echo slash template whose expansion equals send 2's echo does not steal send 2's echo and stays before send 2", async () => {
			const holdSecondInput = createGate();
			const firstReply = createGate();
			const expandSlash: ExtensionFactory = (pi) => {
				pi.on("input", async (event) => {
					if (event.text === "/tpl") return { action: "transform", text: "literal target" };
					if (event.text === "literal target") {
						holdSecondInput.entered.resolve();
						await holdSecondInput.release.promise;
					}
					return { action: "transform", text: rewritten(event.text) };
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [expandSlash] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			const pair = rig.pair;
			assert.ok(pair);
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				async () => {
					firstReply.entered.resolve();
					await firstReply.release.promise;
					return fauxAssistantMessage("first answer");
				},
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			pair.holdHostTrafficFrom((record) => record.type === "agent_start");

			// Send 1 starts with "/", so the host draws no echo for it; the hook expands it to "literal target".
			const first = rig.host.defaultEditor.onSubmit?.("/tpl");
			await firstReply.entered.promise;
			await waitFor("first prompt answered while events are held", () => rig.host.promptTurn === undefined);
			assert.deepEqual(chat(), [], "slash send draws no echo");
			// Send 2's literal text equals send 1's expanded text; its echo is drawn and its input hook holds its answer.
			const second = rig.host.defaultEditor.onSubmit?.("literal target");
			await holdSecondInput.entered.promise;
			assert.deepEqual(chat(), ["literal target"]);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), ["literal target"]);

			// Release send 1's message_start while send 2 is still unanswered:
			// send 1 must NOT steal send 2's echo, and must insert BEFORE send 2's echo.
			await pair.releaseHostTraffic();
			await pair.drain();
			assert.deepEqual(
				chat(),
				["literal target", "literal target"],
				"send 1 is shown without stealing send 2's echo",
			);
			assert.deepEqual(
				Reflect.get(rig.host, "deferredRenderedUserInputs"),
				["literal target"],
				"send 2's echo remains pending while send 2 is unanswered",
			);

			holdSecondInput.release.resolve();
			await waitFor("send 2 queued", () => rig.engine.session.getSteeringMessages().length === 1);
			await pair.drain();
			assert.deepEqual(chat(), ["literal target"]);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);

			firstReply.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["literal target", rewritten("literal target")]);
		});

		test("a no-echo slash template arriving while send 2's distinct echo sits at the tail inserts before send 2, then discards send 2's echo once A1 renders", async () => {
			const holdFirstReply = createGate();
			const holdSecondStart = createGate();
			const expandSlash: ExtensionFactory = (pi) => {
				let secondMessageStart = false;
				pi.on("input", (event) => {
					if (event.text === "/tpl") return { action: "transform", text: "expanded first" };
					return { action: "transform", text: rewritten(event.text) };
				});
				pi.on("message_start", async (event) => {
					if (event.message.role !== "user") return;
					if (!secondMessageStart) {
						secondMessageStart = true;
						return;
					}
					holdSecondStart.entered.resolve();
					await holdSecondStart.release.promise;
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [expandSlash] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			const pair = rig.pair;
			assert.ok(pair);
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				async () => {
					holdFirstReply.entered.resolve();
					await holdFirstReply.release.promise;
					return fauxAssistantMessage("first answer");
				},
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			pair.holdHostTrafficFrom((record) => record.type === "agent_start");

			const first = rig.host.defaultEditor.onSubmit?.("/tpl");
			await holdFirstReply.entered.promise;
			await waitFor("first prompt answered while events are held", () => rig.host.promptTurn === undefined);
			// Send 2 has distinct text "other" and draws its echo before send 1's message_start reaches the chat.
			const second = rig.host.defaultEditor.onSubmit?.("other");
			await waitFor("send 2 echo drawn while events are held", () => chat().length === 1);
			assert.deepEqual(chat.timeline(), ["user:other"]);

			// Release traffic while A1 is still blocked on holdFirstReply:
			// U1 arrives while E2 is at the tail (no non-echo row follows E2), so U1 inserts ahead of E2!
			await pair.releaseHostTraffic();
			await waitFor("send 2 queued behind turn 1", () => rig.engine.session.getSteeringMessages().length === 1);
			await pair.drain();
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first"],
				"queued send 2's echo was discarded after U1 inserted ahead of it",
			);

			// Now verify the started+paused case with distinct text when U1 arrives BEFORE A1 and E2 stays unanswered:
			holdFirstReply.release.resolve();
			await holdSecondStart.entered.promise;
			holdSecondStart.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["expanded first", rewritten("other")]);
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first", "assistant:first answer", `user:${rewritten("other")}`, "assistant:second answer"],
				"turns must remain in [U1, A1, U2, A2] chronological order",
			);
		});

		test("a no-echo slash template arriving after send 2's distinct echo inserts ahead of E2 before A1, then discards stale E2 once A1 renders", async () => {
			const holdSecondInput = createGate();
			const holdFirstReply = createGate();
			const holdSecondStart = createGate();
			const expandSlash: ExtensionFactory = (pi) => {
				let secondMessageStart = false;
				pi.on("input", async (event) => {
					if (event.text === "/tpl") return { action: "transform", text: "expanded first" };
					if (event.text === "other") {
						holdSecondInput.entered.resolve();
						await holdSecondInput.release.promise;
					}
					return { action: "transform", text: rewritten(event.text) };
				});
				pi.on("message_start", async (event) => {
					if (event.message.role !== "user") return;
					if (!secondMessageStart) {
						secondMessageStart = true;
						return;
					}
					holdSecondStart.entered.resolve();
					await holdSecondStart.release.promise;
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [expandSlash] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			const pair = rig.pair;
			assert.ok(pair);
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				async () => {
					holdFirstReply.entered.resolve();
					await holdFirstReply.release.promise;
					return fauxAssistantMessage("first answer");
				},
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			pair.holdHostTrafficFrom((record) => record.type === "agent_start");

			const first = rig.host.defaultEditor.onSubmit?.("/tpl");
			await holdFirstReply.entered.promise;
			await waitFor("first prompt answered while events are held", () => rig.host.promptTurn === undefined);
			const second = rig.host.defaultEditor.onSubmit?.("other");
			await holdSecondInput.entered.promise;
			assert.deepEqual(chat.timeline(), ["user:other"]);

			// Release U1 while both A1 and send 2's input hook are paused: U1 must insert AHEAD of trailing E2!
			await pair.releaseHostTraffic();
			await pair.drain();
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first", "user:other"],
				"U1 must insert ahead of trailing pending echo E2 before A1 arrives",
			);

			// Now finish turn 1 (A1 renders AFTER E2), then release send 2's input hook so send 2 starts turn 2
			// and pauses before U2: expectStartedUserInput sees A1 after E2 and discards E2 cleanly!
			holdFirstReply.release.resolve();
			await waitFor("turn 1 settled", () => rig.engine.eventsOfType("agent_settled").length >= 1);
			await pair.drain();
			holdSecondInput.release.resolve();
			await holdSecondStart.entered.promise;
			await pair.drain();
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first", "assistant:first answer"],
				"send 2's stale echo must not stay wedged above A1 once turn 1's assistant reply has rendered",
			);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);

			holdSecondStart.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages to be answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["expanded first", rewritten("other")]);
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first", "assistant:first answer", `user:${rewritten("other")}`, "assistant:second answer"],
				"turns must remain in [U1, A1, U2, A2] chronological order",
			);
		});

		test("two started turns whose events arrive behind a second echo keep [U1, A1, U2, A2] order for both distinct and colliding rewrites", async () => {
			for (const secondInput of ["second", rewritten("first")] as const) {
				const { rig, chat } = await createRewritingRig(wiring);
				const pair = rig.pair;
				assert.ok(pair);
				rig.engine.setResponses([
					fauxAssistantMessage("reply 1"),
					fauxAssistantMessage("reply 2"),
					fauxAssistantMessage("unexpected extra reply"),
				]);
				pair.holdHostTrafficFrom((record) => record.type === "agent_start");

				const p1 = rig.host.defaultEditor.onSubmit?.("first");
				await waitFor(
					"first turn settled while events are held",
					() => rig.host.promptTurn === undefined && rig.engine.eventsOfType("agent_settled").length >= 1,
				);
				const p2 = rig.host.defaultEditor.onSubmit?.(secondInput);
				await waitFor(
					"second turn settled while events are held",
					() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
				);

				await pair.releaseHostTraffic();
				await Promise.all([p1, p2]);
				await settle(rig);

				assertShownOnceAsSent(rig, chat, [rewritten("first"), rewritten(secondInput)]);
				assert.deepEqual(
					chat.timeline(),
					["user:first (rewritten)", "assistant:reply 1", `user:${rewritten(secondInput)}`, "assistant:reply 2"],
					`secondInput=${secondInput}: turns must stay in [U1, A1, U2, A2] order`,
				);
			}
		});

		test("an input hook that calls sendUserMessage before transforming keeps [U_hook, A_hook, U_trigger, A_trigger] order", async () => {
			const injectBeforeTransform: ExtensionFactory = (pi) => {
				pi.on("input", async (event) => {
					if (event.source === "extension") return { action: "continue" };
					if (event.text === "trigger") {
						pi.sendUserMessage("from-hook");
						await sleep(40);
						return { action: "transform", text: rewritten("trigger") };
					}
					return { action: "continue" };
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [injectBeforeTransform] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			const pair = rig.pair;
			assert.ok(pair);
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				fauxAssistantMessage("reply to hook"),
				fauxAssistantMessage("reply to trigger"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			pair.holdHostTrafficFrom((record) => record.type === "response" && record.command === "prompt");

			const submitted = rig.host.defaultEditor.onSubmit?.("trigger");
			await waitFor(
				"both turns answered in engine",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await pair.releaseHostTraffic();
			await submitted;
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["from-hook", rewritten("trigger")]);
			assert.deepEqual(
				chat.timeline(),
				["user:from-hook", "assistant:reply to hook", `user:${rewritten("trigger")}`, "assistant:reply to trigger"],
				"hook-injected turn must precede the transformed trigger turn",
			);
		});

		test("a post-compaction slash template never inserts above CompactionBoundary under production compactionHold", async () => {
			const refreshGate = createGate();
			const expandSlash: ExtensionFactory = (pi) => {
				pi.on("input", (event) => {
					if (event.text === "/tpl") return { action: "transform", text: "expanded tpl" };
					return { action: "continue" };
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [expandSlash] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			followCompaction(rig);
			const pair = rig.pair;
			assert.ok(pair);
			Object.assign(rig.host.settingsManager, {
				getShowCacheMissNotices: () => false,
				isProjectTrusted: () => true,
			});
			Object.assign(rig.host, {
				pendingTools: new Map(),
				toolOutputExpanded: false,
				hideThinkingBlock: false,
				sessionManager: pair.hostHarness.session.sessionManager,
				resourceDisclosureContainer: new Container(),
				startupNoticesContainer: new Container(),
				attachStartupNoticesContainer: () => {},
				appendProjectTrustWarning: () => {},
				addCompactionCostNotice: () => {},
				updateEditorBorderColor: () => {},
				resetTranscriptSelection: () => {},
				renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
				rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			});
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				fauxAssistantMessage("seed reply 1"),
				fauxAssistantMessage("seed reply 2"),
				fauxAssistantMessage("reply after compact A"),
				fauxAssistantMessage("reply after compact B"),
			]);

			// Seed 2 turns so compact() produces a compaction boundary.
			await rig.host.defaultEditor.onSubmit?.("seed 1");
			await waitFor(
				"seed 1 answered",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await rig.host.defaultEditor.onSubmit?.("seed 2");
			await waitFor(
				"seed 2 answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await pair.drain();

			// Delay production refreshSessionView once compactionHold opens on compaction_end.
			const runtime = pair.runtime as unknown as {
				compactionHold?: unknown;
				refreshSessionView: (valid?: () => boolean) => Promise<void>;
			};
			const origRefresh = runtime.refreshSessionView.bind(runtime);
			let intercepted = false;
			runtime.refreshSessionView = async (valid?: () => boolean) => {
				const result = await origRefresh(valid);
				if (!intercepted && runtime.compactionHold !== undefined) {
					intercepted = true;
					refreshGate.entered.resolve();
					await refreshGate.release.promise;
				}
				return result;
			};

			const compacting = rig.host.session.compact();
			await refreshGate.entered.promise;
			await compacting;

			const pA = rig.host.defaultEditor.onSubmit?.("/tpl");
			await waitFor(
				"Turn A settled on engine during compactionHold",
				() => getUserTexts(rig.engine).includes("expanded tpl") && isIdleAfterAnswering(rig.engine),
			);
			const pB = rig.host.defaultEditor.onSubmit?.("other");
			await waitFor(
				"Turn B settled on engine during compactionHold",
				() => getUserTexts(rig.engine).includes("other") && isIdleAfterAnswering(rig.engine),
			);

			refreshGate.release.resolve();
			await Promise.all([pA, pB]);
			await settle(rig);

			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);
			assert.deepEqual(
				chat.timeline(),
				[
					"compaction-boundary",
					"user:expanded tpl",
					"assistant:reply after compact A",
					"user:other",
					"assistant:reply after compact B",
				],
				"post-compaction messages must appear strictly below CompactionBoundary in turn order",
			);
		});

		test("steer-while-busy draws its echo at the tail after an earlier tagged no-echo turn finishes", async () => {
			const holdSecondStart = createGate();
			const expandSlash: ExtensionFactory = (pi) => {
				let secondUser = false;
				pi.on("input", (event) => {
					if (event.text === "/tpl") return { action: "transform", text: "expanded first" };
					return { action: "transform", text: rewritten(event.text) };
				});
				pi.on("message_start", async (event) => {
					if (event.message.role !== "user") return;
					if (!secondUser) {
						secondUser = true;
						return;
					}
					holdSecondStart.entered.resolve();
					await holdSecondStart.release.promise;
				});
			};
			const rig = await createRig(wiring, "quiet", { extensions: [expandSlash] });
			rigs.push(rig);
			const chat = showUserMessagesInChat(rig.host);
			const pair = rig.pair;
			assert.ok(pair);
			await pair.runtime.waitUntilResourcesReady();
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			// Hold from /tpl's user message_start (AFTER agent_start sets isStreaming = true on host!):
			// then send 2 submits on the steer-while-busy path with shownBefore=0, taggedBefore=0 BEFORE /tpl's
			// tagged message_start reaches the host!
			pair.holdHostTrafficFrom((record) => record.type === "message_start" && record.message.role === "user");

			const first = rig.host.defaultEditor.onSubmit?.("/tpl");
			await waitFor(
				"first turn settled in engine while host sees streaming and holds U1",
				() => rig.engine.eventsOfType("agent_settled").length >= 1 && isIdleAfterAnswering(rig.engine),
			);
			await pair.drain();
			assert.equal(rig.host.session.isStreaming, true);
			assert.deepEqual(chat.timeline(), [], "U1 has not reached the host yet");

			// Submit send 2 on the steer-while-busy path (captures shownBefore=0, taggedBefore=0 BEFORE U1 arrives);
			// also pause send 2's message_start so we observe send 2's echo drawn after U1 + A1!
			const second = rig.host.defaultEditor.onSubmit?.("other");
			await holdSecondStart.entered.promise;

			await pair.releaseHostTraffic();
			await pair.drain();
			assert.deepEqual(
				chat.timeline(),
				["user:expanded first", "assistant:first answer", "user:other"],
				"steer-while-busy draws send 2's echo at the tail after A1 without being suppressed by send 1's tagged show",
			);
			assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), ["other"]);

			holdSecondStart.release.resolve();
			await Promise.all([first, second]);
			await waitFor(
				"both messages answered",
				() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await settle(rig);

			assertShownOnceAsSent(rig, chat, ["expanded first", rewritten("other")]);
			assert.deepEqual(chat.timeline(), [
				"user:expanded first",
				"assistant:first answer",
				`user:${rewritten("other")}`,
				"assistant:second answer",
			]);
		});

		test("falls back to text and FIFO matching when connected to an older engine that omits origin send ids", async () => {
			const { rig, chat } = await createRewritingRig(wiring, { echoOrigin: false });
			const pair = rig.pair;
			assert.ok(pair);
			rig.engine.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
				fauxAssistantMessage("third answer"),
				fauxAssistantMessage("unexpected extra reply"),
			]);

			// 1. Answer read after rewritten message_start (#4272/#4277): untagged baseline must still clear the echo.
			pair.holdHostTrafficFrom((record) => record.type === "response" && record.command === "prompt");
			await rig.host.defaultEditor.onSubmit?.("first");
			await waitFor(
				"first message answered in engine",
				() => getUserTexts(rig.engine).length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await pair.releaseHostTraffic();
			await settle(rig);
			assertShownOnceAsSent(rig, chat, [rewritten("first")]);

			// 2. Steer-while-busy path whose message_start arrives before its "started" answer (#4272): no duplicate echo.
			pair.holdHostTrafficFrom((record) => record.type === "agent_end");
			await rig.host.defaultEditor.onSubmit?.("second");
			await waitFor(
				"second turn settled in engine",
				() => rig.engine.eventsOfType("agent_settled").length === 2 && isIdleAfterAnswering(rig.engine),
			);
			await pair.drain();
			assert.equal(rig.host.session.isStreaming, true, "host still sees second turn running");
			const third = rig.host.defaultEditor.onSubmit?.("third");
			await waitFor(
				"third message answered in engine",
				() => getUserTexts(rig.engine).includes(rewritten("third")) && isIdleAfterAnswering(rig.engine),
			);
			await pair.releaseHostTraffic();
			await third;
			await settle(rig);
			assertShownOnceAsSent(rig, chat, [rewritten("first"), rewritten("second"), rewritten("third")]);
		});
	}

	test("rewritten send 1 whose output equals held send 2's literal echo leaves send 2's echo intact until send 2 queues", async () => {
		const preparing = createGate();
		const holdSecondInput = createGate();
		const holdFirstReply = createGate();
		const holdHooks: ExtensionFactory = (pi) => {
			let prepare = true;
			pi.on("input", async (event) => {
				if (event.text === rewritten("hello")) {
					holdSecondInput.entered.resolve();
					await holdSecondInput.release.promise;
				}
				return { action: "transform", text: rewritten(event.text) };
			});
			pi.on("before_agent_start", async () => {
				if (!prepare) return;
				prepare = false;
				preparing.entered.resolve();
				await preparing.release.promise;
			});
		};
		const rig = await createRig(wiring, "quiet", { extensions: [holdHooks] });
		rigs.push(rig);
		const chat = showUserMessagesInChat(rig.host);
		await rig.pair?.runtime.waitUntilResourcesReady();
		rig.engine.setResponses([
			async () => {
				holdFirstReply.entered.resolve();
				await holdFirstReply.release.promise;
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("unexpected extra reply"),
		]);

		const first = rig.host.defaultEditor.onSubmit?.("hello");
		await preparing.entered.promise;
		// Send 2's literal text equals send 1's rewrite; host holds it while send 1 prepares.
		const second = rig.host.defaultEditor.onSubmit?.(rewritten("hello"));
		await waitFor("the host to hold the second message", () => rig.host.compactionQueuedMessages.length === 1);
		preparing.release.resolve();
		// sendHeldInput draws send 2's echo and waits inside send 2's input hook while send 1's message_start arrives!
		await holdSecondInput.entered.promise;
		await holdFirstReply.entered.promise;
		if (rig.pair) await rig.pair.drain();

		// Send 1's message_start has already reached the chat while send 2 is still unanswered:
		// send 1 must have replaced its own echo ("hello"), leaving send 2's echo ("hello (rewritten)") pending.
		assert.deepEqual(
			chat(),
			[rewritten("hello"), rewritten("hello")],
			"send 1 must replace its own echo at row 0, keeping send 2's echo at row 1",
		);
		assert.deepEqual(
			Reflect.get(rig.host, "deferredRenderedUserInputs"),
			[rewritten("hello")],
			"only send 2's echo remains pending while send 2 waits for its answer",
		);

		holdSecondInput.release.resolve();
		await waitFor(
			"send 2 queued and its echo discarded",
			() => rig.engine.session.getSteeringMessages().length === 1,
		);
		if (rig.pair) await rig.pair.drain();
		assert.deepEqual(chat(), [rewritten("hello")], "send 2's echo is discarded when answered queued");
		assert.deepEqual(Reflect.get(rig.host, "deferredRenderedUserInputs"), []);

		holdFirstReply.release.resolve();
		await Promise.all([first, second]);
		await waitFor(
			"both messages to be answered",
			() => getUserTexts(rig.engine).length === 2 && isIdleAfterAnswering(rig.engine),
		);
		await settle(rig);

		assertShownOnceAsSent(rig, chat, [rewritten("hello"), rewritten(rewritten("hello"))]);
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
				"error: Compaction failed: Nothing to compact: the context holds nothing new since the last boundary",
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
	return (atomic) => {
		atomic.on("input", async (event) => {
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
