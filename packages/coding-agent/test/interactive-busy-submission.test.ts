import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.ts";
import {
	createInteractiveSubmissionHost,
	type InteractiveSubmissionHost,
	startInteractiveInputLoop,
} from "./helpers/interactive-submission-host.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2;
const RETRY_BACKOFF_MS = 400;
const BACKGROUND_SESSION_COUNT = 8;
const BACKGROUND_REPLY_DELAY_MS = 6;
const EVENT_LOOP_STALL_MS = 25;
const EVENT_LOOP_STALL_PERIOD_MS = 30;
const PIPE_LAG_MS = 20;
const DUPLICATE_DELIVERY_SETTLE_MS = 50;

type Wiring = "local" | "isolated";
type Load = "quiet" | "loaded";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let describeState: () => string = () => "";

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + SETTLE_TIMEOUT_MS;
	while (!predicate()) {
		if (performance.now() > deadline) assert.fail(`timed out waiting for ${description}; ${describeState()}`);
		await sleep(POLL_INTERVAL_MS);
	}
}

interface Gate {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const openGates: Gate[] = [];

function createGate(): Gate {
	const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
	openGates.push(gate);
	return gate;
}

function releaseOpenGates(): void {
	for (const gate of openGates.splice(0)) gate.release.resolve();
}

function gateOnce(gate: Gate): () => Promise<void> {
	let armed = true;
	return async () => {
		if (!armed) return;
		armed = false;
		gate.entered.resolve();
		await gate.release.promise;
	};
}

function hookGate(event: "before_agent_start" | "agent_start", gate: Gate): ExtensionFactory {
	const run = gateOnce(gate);
	return (pi) => {
		pi.on(event, async () => {
			await run();
		});
	};
}

function holdTool(gate?: Gate): AgentTool {
	const run = gate ? gateOnce(gate) : async () => {};
	return {
		name: "hold",
		label: "Hold",
		description: "Holds the run open until released",
		parameters: Type.Object({}),
		execute: async () => {
			await run();
			return { content: [{ type: "text", text: "held" }], details: {} };
		},
	};
}

function startEventLoopLoad(): () => void {
	const timer = setInterval(() => {
		const end = performance.now() + EVENT_LOOP_STALL_MS;
		while (performance.now() < end) {
			Math.sqrt(end);
		}
	}, EVENT_LOOP_STALL_PERIOD_MS);
	return () => clearInterval(timer);
}

async function startBackgroundSessions(count: number): Promise<() => Promise<void>> {
	const sessions: Harness[] = [];
	const loops: Promise<void>[] = [];
	let stopped = false;
	for (let index = 0; index < count; index++) {
		const background = await createHarness();
		sessions.push(background);
		background.setResponses(
			Array.from({ length: 2000 }, () => async () => {
				await sleep(BACKGROUND_REPLY_DELAY_MS);
				return fauxAssistantMessage("background reply");
			}),
		);
		loops.push(
			(async () => {
				while (!stopped) await background.session.prompt("background").catch(() => {});
			})(),
		);
	}
	return async () => {
		stopped = true;
		await Promise.allSettled(loops);
		for (const background of sessions) await background.cleanup();
	};
}

interface Rig {
	engine: Harness;
	host: InteractiveSubmissionHost;
	pair: EngineHostPair | undefined;
	stop: () => Promise<void>;
}

interface RigOptions {
	extensions?: ExtensionFactory[];
	tools?: AgentTool[];
	settings?: Partial<Settings>;
}

async function createRig(wiring: Wiring, load: Load, options: RigOptions): Promise<Rig> {
	const stops: Array<() => Promise<void> | void> = [];
	if (load === "loaded") {
		stops.push(startEventLoopLoad());
		stops.push(await startBackgroundSessions(BACKGROUND_SESSION_COUNT));
	}
	let engine: Harness;
	let host: InteractiveSubmissionHost;
	let pair: EngineHostPair | undefined;
	if (wiring === "isolated") {
		pair = await createEngineHostPair({
			engineExtensions: options.extensions,
			tools: options.tools,
			settings: options.settings,
		});
		if (load === "loaded") pair.setLag({ toEngineMs: PIPE_LAG_MS, toHostMs: PIPE_LAG_MS });
		engine = pair.engine;
		host = createInteractiveSubmissionHost(pair.runtime.session);
		host.runtimeHost = pair.runtime;
		stops.push(() => pair?.cleanup());
	} else {
		engine = await createHarness({
			extensionFactories: options.extensions,
			tools: options.tools,
			settings: options.settings,
		});
		host = createInteractiveSubmissionHost(engine.session);
		stops.push(() => engine.cleanup());
	}
	host.session.subscribe((event) => {
		if (event.type === "queue_update") host.updatePendingMessagesDisplay();
	});
	describeState = () =>
		JSON.stringify({
			transcript: engine.session.messages.map((message) => `${message.role}:${getMessageText(message)}`),
			notices: host.notices,
			rendered: host.rendered,
			discarded: host.discarded,
			engineSteering: engine.session.getSteeringMessages(),
			held: host.compactionQueuedMessages,
			streaming: engine.session.isStreaming,
		});
	const loop = startInteractiveInputLoop(host);
	stops.push(() => loop.stop());
	return {
		engine,
		host,
		pair,
		stop: async () => {
			for (const stop of stops.reverse()) await stop();
		},
	};
}

function isVisible(host: InteractiveSubmissionHost, text: string): boolean {
	const pending = host.pendingMessagesContainer.render(200).join("\n");
	return pending.includes(text) || (host.rendered.includes(text) && !host.discarded.includes(text));
}

function countOf(texts: string[], text: string): number {
	return texts.filter((candidate) => candidate === text).length;
}

function isIdleAfterAnswering(engine: Harness): boolean {
	return !engine.session.isStreaming && engine.session.messages.at(-1)?.role === "assistant";
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
		turnStart.release.resolve();
		firstReply.release.resolve();
		await waitFor("the typed message to be answered", () =>
			getAssistantTexts(rig.engine).includes("answer to the typed message"),
		);

		assert.equal(countOf(getUserTexts(rig.engine), "M-stale"), 1, "the typed message was not delivered exactly once");
		assert.deepEqual(rig.host.notices, [], "the busy engine rejected the message");
		assert.deepEqual(rig.host.discarded, [], "the typed message was shown and then discarded");
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
