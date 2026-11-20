import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import type { AssistantMessage } from "@bastani/atomic-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { stripAnsi } from "../src/utils/ansi.js";
import {
	createGate,
	createRig,
	type Gate,
	type Rig,
	releaseOpenGates,
	sleep,
	waitFor,
} from "./helpers/busy-submission-rig.js";
import { pressAltEnter, pressAltUp } from "./helpers/interactive-submission-host.js";
import { getMessageText } from "./suite/harness.js";

/**
 * The main chat's steering, recorded step by step: the queued rows each key leaves above the prompt, the editor text
 * Alt+Up and Escape give back, the notices, and the tail of every request the model receives. The expected traces
 * were recorded from the main chat before it moved onto the shared steering controller; the main chat must keep
 * producing them exactly.
 */

const ROW_WIDTH = 60;

function rows(rig: Rig): string[] {
	return rig.host.pendingMessagesContainer.render(ROW_WIDTH).map((line) => stripAnsi(line));
}

/** Hand the host every `queue_update` the way InteractiveMode's own event handler does. */
function handleQueueUpdates(rig: Rig): void {
	Object.assign(rig.host, { isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} } });
	const handleEvent: (this: Rig["host"], event: object) => Promise<void> = Reflect.get(
		InteractiveMode.prototype,
		"handleEvent",
	);
	rig.host.session.subscribe((event) => {
		if (event.type === "queue_update") void handleEvent.call(rig.host, event);
	});
}

/** A tool that runs until `gate` opens, or stops at once when the run is interrupted, as a shell command does. */
function holdTool(gate: Gate): AgentTool {
	return {
		name: "hold",
		label: "Hold",
		description: "Holds the run open until released",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			gate.entered.resolve();
			const aborted = new Promise<"aborted">((resolve) => {
				if (signal?.aborted) resolve("aborted");
				signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
			});
			const outcome = await Promise.race([gate.release.promise.then(() => "held" as const), aborted]);
			return { content: [{ type: "text", text: outcome }], details: {} };
		},
	};
}

/** Answer with `reply`, recording what the request carried after the model's last message. */
function recorded(requests: string[][], reply: AssistantMessage): FauxResponseStep {
	return (context) => {
		const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
		requests.push(
			context.messages.slice(lastAssistant + 1).map((message) => `${message.role}:${getMessageText(message)}`),
		);
		return reply;
	};
}

async function settle(rig: Rig): Promise<void> {
	if (rig.pair) await rig.pair.drain();
	await sleep(50);
	if (rig.pair) await rig.pair.drain();
}

interface Recording {
	rig: Rig;
	toolHold: Gate;
	requests: string[][];
	trace: string[];
	note: (step: string) => void;
}

describe.each(["local", "isolated"] as const)("the main chat's steering (%s host)", (wiring) => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	/** Start a turn that holds in a tool call, with every later request answered and recorded. */
	async function startBusyTurn(): Promise<Recording> {
		const toolHold = createGate();
		const rig = await createRig(wiring, "quiet", { tools: [holdTool(toolHold)] });
		rigs.push(rig);
		handleQueueUpdates(rig);
		const requests: string[][] = [];
		rig.engine.setResponses([
			recorded(requests, fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })),
			...Array.from({ length: 6 }, (_, index) => recorded(requests, fauxAssistantMessage(`answer ${index + 2}`))),
		]);
		const trace: string[] = [];
		const note = (step: string) => {
			trace.push(`${step} | editor=${JSON.stringify(rig.host.editor.getText())}`);
			for (const line of rows(rig)) trace.push(`  row ${JSON.stringify(line)}`);
		};
		await rig.host.defaultEditor.onSubmit?.("first");
		await toolHold.entered.promise;
		await waitFor("the host to see the turn", () => rig.host.session.isStreaming);
		return { rig, toolHold, requests, trace, note };
	}

	async function finish({ rig, requests, trace }: Recording, expectedRequests: number): Promise<void> {
		await waitFor("the run to finish", () => !rig.engine.session.isStreaming && requests.length >= expectedRequests);
		await settle(rig);
		for (const [index, tail] of requests.entries()) trace.push(`request ${index + 1}: ${tail.join(" + ")}`);
		for (const notice of rig.host.notices) trace.push(`notice ${notice}`);
	}

	test("Enter steers and Alt+Enter follows up while the agent works; the model receives each as typed", async () => {
		const recording = await startBusyTurn();
		const { rig, toolHold, note } = recording;
		note("busy");
		for (const [key, text] of [
			["Enter", "steer alpha"],
			["Enter", "steer beta"],
			["Alt+Enter", "follow gamma"],
		] as const) {
			const submitted = key === "Enter" ? rig.host.defaultEditor.onSubmit?.(text) : pressAltEnter(rig.host, text);
			note(`${key} ${text} (same frame)`);
			await submitted;
			await settle(rig);
			note(`${key} ${text} (confirmed)`);
		}
		toolHold.release.resolve();
		await finish(recording, 4);
		note("done");
		assert.deepEqual(recording.trace, [
			'busy | editor=""',
			'Enter steer alpha (same frame) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Enter steer alpha (confirmed) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Enter steer beta (same frame) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " Steering: steer beta                                       "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Enter steer beta (confirmed) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " Steering: steer beta                                       "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Alt+Enter follow gamma (same frame) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " Steering: steer beta                                       "',
			'  row " Follow-up: follow gamma                                    "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Alt+Enter follow gamma (confirmed) | editor=""',
			'  row ""',
			'  row " Steering: steer alpha                                      "',
			'  row " Steering: steer beta                                       "',
			'  row " Follow-up: follow gamma                                    "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			"request 1: system: + user:first",
			"request 2: toolResult:held + user:steer alpha",
			"request 3: user:steer beta",
			"request 4: user:follow gamma",
			'done | editor=""',
		]);
	});

	test("Alt+Up takes every queued message back into the editor, ahead of the draft, and sends none", async () => {
		const recording = await startBusyTurn();
		const { rig, toolHold, note } = recording;
		await rig.host.defaultEditor.onSubmit?.("steer one");
		await pressAltEnter(rig.host, "follow two");
		await rig.host.defaultEditor.onSubmit?.("steer three");
		await settle(rig);
		rig.host.editor.setText("draft");
		note("queued");
		pressAltUp(rig.host);
		await waitFor("the queue to come back", () => rig.host.editor.getText() !== "draft");
		await settle(rig);
		note("Alt+Up");
		rig.host.editor.setText("");
		pressAltUp(rig.host);
		await settle(rig);
		note("Alt+Up with nothing queued");
		toolHold.release.resolve();
		await finish(recording, 2);
		assert.deepEqual(recording.trace, [
			'queued | editor="draft"',
			'  row ""',
			'  row " Steering: steer one                                        "',
			'  row " Steering: steer three                                      "',
			'  row " Follow-up: follow two                                      "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Alt+Up | editor="steer one\\n\\nsteer three\\n\\nfollow two\\n\\ndraft"',
			'Alt+Up with nothing queued | editor=""',
			"request 1: system: + user:first",
			"request 2: toolResult:held",
			"notice status: No queued messages to restore",
		]);
	});

	test("Escape with a queue interrupts, takes the queue back into the editor and holds nothing for later", async () => {
		const recording = await startBusyTurn();
		const { rig, toolHold, note } = recording;
		await rig.host.defaultEditor.onSubmit?.("steer one");
		await pressAltEnter(rig.host, "follow two");
		await settle(rig);
		rig.host.editor.setText("draft");
		note("queued");
		rig.host.defaultEditor.onEscape?.();
		note("Escape (same frame)");
		await waitFor("the queue to come back", () => rig.host.editor.getText() !== "draft");
		await waitFor("the turn to stop", () => !rig.engine.session.isStreaming);
		toolHold.release.resolve();
		await settle(rig);
		note(`Escape (settled, paused=${rig.host.session.queuedMessagesPaused})`);
		rig.host.editor.setText("");
		await rig.host.defaultEditor.onSubmit?.("continue");
		await finish(recording, 2);
		note(`done (paused=${rig.host.session.queuedMessagesPaused})`);
		assert.deepEqual(recording.trace, [
			'queued | editor="draft"',
			'  row ""',
			'  row " Steering: steer one                                        "',
			'  row " Follow-up: follow two                                      "',
			'  row " ↳ alt+up to edit all queued messages                       "',
			'Escape (same frame) | editor="draft"',
			'Escape (settled, paused=true) | editor="steer one\\n\\nfollow two\\n\\ndraft"',
			"request 1: system: + user:first",
			"request 2: toolResult:aborted",
			"request 3: user:continue",
			'done (paused=false) | editor=""',
		]);
	});
});
