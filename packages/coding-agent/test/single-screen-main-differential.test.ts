import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * The main chat while the single chat screen is installed and shows main: every row above the prompt, the editor, the
 * notices and the tail of every model request, step by step, must be what origin/main produced. The expected traces
 * below were recorded by running this file on origin/main (92bb3108a4), where the single screen does not exist; here
 * `installAgentView` runs on the host first, as `init()` runs it.
 */

const INSTALL = new URL("../src/modes/interactive/agent-view/install.ts", import.meta.url);
/** Whether this tree has the single chat screen (origin/main, where the traces were recorded, does not). */
const SINGLE_SCREEN = existsSync(fileURLToPath(INSTALL));
const ROW_WIDTH = 60;

const rigs: Rig[] = [];
afterEach(async () => {
	releaseOpenGates();
	while (rigs.length > 0) await rigs.pop()?.stop();
});

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
function recorded(requests: string[][], reply: AssistantMessage | (() => Promise<AssistantMessage>)): FauxResponseStep {
	return async (context) => {
		const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
		requests.push(
			context.messages.slice(lastAssistant + 1).map((message) => `${message.role}:${getMessageText(message)}`),
		);
		return typeof reply === "function" ? reply() : reply;
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

/** A main chat whose first turn holds in a tool call until `toolHold` opens; later requests are answered and recorded. */
async function busyMainChat(
	wiring: "local" | "isolated",
	options: { recover?: boolean; holdAnswer?: Promise<void> } = {},
): Promise<Recording> {
	const toolHold = createGate();
	const rig = await createRig(wiring, "quiet", { tools: [holdTool(toolHold)] });
	rigs.push(rig);
	Object.assign(rig.host, { isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} } });
	if (SINGLE_SCREEN) {
		const { installAgentView } = (await import(
			INSTALL.href
		)) as typeof import("../src/modes/interactive/agent-view/install.ts");
		installAgentView(rig.host as unknown as Parameters<typeof installAgentView>[0]);
	}
	const handleEvent: (this: Rig["host"], event: object) => Promise<void> = Reflect.get(
		InteractiveMode.prototype,
		"handleEvent",
	);
	rig.host.session.subscribe((event) => {
		if (event.type === "queue_update") void handleEvent.call(rig.host, event);
	});
	if (options.recover) {
		const attach: (this: Rig["host"]) => () => void = Reflect.get(
			InteractiveMode.prototype,
			"attachSteeringEngineRecovery",
		);
		const detach = attach.call(rig.host);
		rigs.push({ ...rig, stop: async () => detach() });
	}
	const requests: string[][] = [];
	const holdAnswer = options.holdAnswer;
	rig.engine.setResponses([
		recorded(requests, fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })),
		recorded(
			requests,
			holdAnswer
				? async () => {
						await holdAnswer;
						return fauxAssistantMessage("answer 2");
					}
				: fauxAssistantMessage("answer 2"),
		),
		...Array.from({ length: 6 }, (_, index) => recorded(requests, fauxAssistantMessage(`answer ${index + 3}`))),
	]);
	const trace: string[] = [];
	const note = (step: string) => {
		trace.push(`${step} | editor=${JSON.stringify(rig.host.editor.getText())}`);
		for (const line of rig.host.pendingMessagesContainer.render(ROW_WIDTH))
			trace.push(`  row ${JSON.stringify(stripAnsi(line))}`);
	};
	await rig.host.defaultEditor.onSubmit?.("first");
	await toolHold.entered.promise;
	await waitFor("the host to see the turn", () => rig.host.session.isStreaming);
	return { rig, toolHold, requests, trace, note };
}

async function finish({ rig, requests, trace }: Recording, expectedRequests: number): Promise<string[]> {
	await waitFor("the run to finish", () => !rig.engine.session.isStreaming && requests.length >= expectedRequests);
	await settle(rig);
	for (const [index, tail] of requests.entries()) trace.push(`request ${index + 1}: ${tail.join(" + ")}`);
	for (const notice of rig.host.notices) trace.push(`notice ${notice}`);
	return trace;
}

/** Compare with origin/main's trace; `SINGLE_SCREEN_DIFF_PRINT=1` prints the trace to record it. */
function matchesOrigin(name: string, trace: readonly string[], expected: readonly string[]): void {
	if (process.env.SINGLE_SCREEN_DIFF_PRINT === "1")
		process.stdout.write(`TRACE ${name}\n${JSON.stringify(trace, null, "\t")}\n`);
	assert.deepEqual(trace, expected, `${name}: the main chat differs from origin/main`);
}

describe.each(["local", "isolated"] as const)(
	"the main chat with the single chat screen installed (%s host)",
	(wiring) => {
		test("Enter steers, Alt+Enter follows up and Alt+Up takes the queue back exactly as on origin/main", async () => {
			const recording = await busyMainChat(wiring);
			const { rig, toolHold, note } = recording;
			note("busy");
			await rig.host.defaultEditor.onSubmit?.("steer one");
			note("Enter steer one (same frame)");
			await pressAltEnter(rig.host, "follow two");
			await settle(rig);
			note("Alt+Enter follow two (confirmed)");
			rig.host.editor.setText("draft");
			pressAltUp(rig.host);
			await waitFor("the queue to come back", () => rig.host.editor.getText() !== "draft");
			await settle(rig);
			note("Alt+Up");
			rig.host.editor.setText("");
			await rig.host.defaultEditor.onSubmit?.("steer three");
			await settle(rig);
			note("Enter steer three (confirmed)");
			toolHold.release.resolve();
			matchesOrigin(`steering-${wiring}`, await finish(recording, 2), EXPECTED.steering);
		});

		test("Escape with a queue takes it back into main's editor, also when the engine answers late", async () => {
			const recording = await busyMainChat(wiring);
			const { rig, toolHold, note } = recording;
			await rig.host.defaultEditor.onSubmit?.("steer one");
			await pressAltEnter(rig.host, "follow two");
			await settle(rig);
			rig.host.editor.setText("draft");
			note("queued");
			// The engine's answers wait: the queue comes back only after Escape's round trip.
			rig.pair?.holdHostTrafficFrom(() => true);
			rig.host.defaultEditor.onEscape?.();
			note("Escape (same frame)");
			await rig.pair?.releaseHostTraffic();
			await waitFor("the queue to come back", () => rig.host.editor.getText() !== "draft");
			await waitFor("the turn to stop", () => !rig.engine.session.isStreaming);
			toolHold.release.resolve();
			await settle(rig);
			note(`Escape (settled, paused=${rig.host.session.queuedMessagesPaused})`);
			rig.host.editor.setText("");
			await rig.host.defaultEditor.onSubmit?.("continue");
			matchesOrigin(`escape-${wiring}`, await finish(recording, 3), EXPECTED.escape);
		});

		test.runIf(wiring === "isolated")(
			"a message the engine refuses comes back to main's editor with the notice",
			async () => {
				const recording = await busyMainChat(wiring);
				const { rig, toolHold, note } = recording;
				rig.pair?.failCommand("prompt", "engine refused the message");
				const submitted = rig.host.defaultEditor.onSubmit?.("typed while busy");
				note("Enter (same frame)");
				await submitted;
				await settle(rig);
				note("refused");
				rig.pair?.failCommand("prompt", undefined);
				toolHold.release.resolve();
				matchesOrigin("refused-isolated", await finish(recording, 2), EXPECTED.refused);
			},
		);

		test.runIf(wiring === "isolated")(
			"a crashed engine's queue comes back to main's editor with the notice",
			async () => {
				const recording = await busyMainChat(wiring, { recover: true });
				const { rig, toolHold, note } = recording;
				await rig.host.defaultEditor.onSubmit?.("steer alpha");
				await pressAltEnter(rig.host, "follow beta");
				await settle(rig);
				rig.host.editor.setText("half typed");
				note("queued");
				rig.pair?.crash();
				toolHold.release.resolve();
				await waitFor("the restore notice", () =>
					rig.host.notices.some((notice) => notice.includes("Engine restarted")),
				);
				await settle(rig);
				note("recovered");
				await rig.host.defaultEditor.onSubmit?.("after");
				matchesOrigin("crash-isolated", await finish(recording, 2), EXPECTED.crash);
			},
		);
	},
);

/** Recorded on origin/main 92bb3108a4 (`SINGLE_SCREEN_DIFF_PRINT=1`), identical for both hosts where both run. */
const EXPECTED: Record<"steering" | "escape" | "refused" | "crash", readonly string[]> = {
	steering: [
		'busy | editor=""',
		'Enter steer one (same frame) | editor=""',
		'  row ""',
		'  row " Steering: steer one                                        "',
		'  row " ↳ alt+up to edit all queued messages                       "',
		'Alt+Enter follow two (confirmed) | editor=""',
		'  row ""',
		'  row " Steering: steer one                                        "',
		'  row " Follow-up: follow two                                      "',
		'  row " ↳ alt+up to edit all queued messages                       "',
		'Alt+Up | editor="steer one\\n\\nfollow two\\n\\ndraft"',
		'Enter steer three (confirmed) | editor=""',
		'  row ""',
		'  row " Steering: steer three                                      "',
		'  row " ↳ alt+up to edit all queued messages                       "',
		"request 1: system: + user:first",
		"request 2: toolResult:held + user:steer three",
	],
	escape: [
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
	],
	refused: [
		'Enter (same frame) | editor=""',
		'  row ""',
		'  row " Steering: typed while busy                                 "',
		'  row " ↳ alt+up to edit all queued messages                       "',
		'refused | editor="typed while busy"',
		"request 1: system: + user:first",
		"request 2: toolResult:held",
		"notice error: engine refused the message",
	],
	crash: [
		'queued | editor="half typed"',
		'  row ""',
		'  row " Steering: steer alpha                                      "',
		'  row " Follow-up: follow beta                                     "',
		'  row " ↳ alt+up to edit all queued messages                       "',
		'recovered | editor="steer alpha\\n\\nfollow beta\\n\\nhalf typed"',
		"request 1: system: + user:first",
		"request 2: toolResult:aborted",
		"request 3: user:after",
		"notice warning: Engine restarted; 2 queued messages weren't sent and are back in the editor",
	],
};
