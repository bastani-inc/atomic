import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { stripAnsi } from "../src/utils/ansi.js";
import {
	createGate,
	createRig,
	type Gate,
	gateOnce,
	holdTool,
	type Rig,
	releaseOpenGates,
	waitFor,
} from "./helpers/busy-submission-rig.js";
import { pressAltEnter } from "./helpers/interactive-submission-host.js";

/** An `input` hook that holds `text`, as a session busy with other work delays it. */
function slowInputHook(gate: Gate, text: string): ExtensionFactory {
	const wait = gateOnce(gate);
	return (pi) => {
		pi.on("input", async (event) => {
			if (event.text === text) await wait();
			return { action: "continue" };
		});
	};
}

function queuedRows(rig: Rig): string[] {
	return rig.host.pendingMessagesContainer
		.render(200)
		.map((line) => stripAnsi(line).trim())
		.filter((line) => line.startsWith("Steering:") || line.startsWith("Follow-up:"));
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

describe.each(["local", "isolated"] as const)("a message sent while the agent works (%s host)", (wiring) => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	async function startBusyTurn(options: { slowInput?: Gate } = {}): Promise<{ rig: Rig; finishTurn: () => void }> {
		const toolHold = createGate();
		const rig = await createRig(wiring, "quiet", {
			tools: [holdTool(toolHold)],
			extensions: options.slowInput ? [slowInputHook(options.slowInput, "typed while busy")] : [],
		});
		rigs.push(rig);
		handleQueueUpdates(rig);
		rig.engine.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
			fauxAssistantMessage("answered again"),
		]);
		await rig.host.defaultEditor.onSubmit?.("first");
		await toolHold.entered.promise;
		await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
		return { rig, finishTurn: () => toolHold.release.resolve() };
	}

	const lanes = [
		{
			lane: "steering",
			row: "Steering: typed while busy",
			submit: (rig: Rig) => rig.host.defaultEditor.onSubmit?.("typed while busy"),
			engineQueue: (rig: Rig) => rig.engine.session.getSteeringMessages(),
		},
		{
			lane: "follow-up",
			row: "Follow-up: typed while busy",
			submit: (rig: Rig) => pressAltEnter(rig.host, "typed while busy"),
			engineQueue: (rig: Rig) => rig.engine.session.getFollowUpMessages(),
		},
	] as const;

	for (const { lane, row, submit, engineQueue } of lanes) {
		test(`shows a ${lane} message as queued at submit, before the session confirms it (#4696)`, async () => {
			const slowInput = createGate();
			const { rig, finishTurn } = await startBusyTurn({ slowInput });

			const submitted = submit(rig);
			assert.deepEqual(queuedRows(rig), [row], "the row must be there in the frame that clears the editor");

			await slowInput.entered.promise;
			assert.deepEqual(engineQueue(rig), [], "the session has not queued it yet");
			assert.deepEqual(queuedRows(rig), [row]);

			slowInput.release.resolve();
			await waitFor("the session to queue it", () => engineQueue(rig).includes("typed while busy"));
			await submitted;
			await rig.pair?.drain();
			assert.deepEqual(queuedRows(rig), [row], "the confirmed message is listed once");

			finishTurn();
			await waitFor("the turn to take it", () => queuedRows(rig).length === 0);
		});
	}

	test("lists a confirmed message once while the session's answer is still on its way (#4696)", async () => {
		const { rig, finishTurn } = await startBusyTurn();
		// The engine's queue_update reaches the host on its own, ahead of the answer to the prompt.
		rig.pair?.holdHostTrafficFrom((record) => record.type === "response");

		const submitted = rig.host.defaultEditor.onSubmit?.("typed while busy");
		await waitFor("the host to hear the session queued it", () =>
			rig.host.session.getSteeringMessages().includes("typed while busy"),
		);
		assert.deepEqual(queuedRows(rig), ["Steering: typed while busy"]);

		await rig.pair?.releaseHostTraffic();
		await submitted;
		assert.deepEqual(queuedRows(rig), ["Steering: typed while busy"]);
		finishTurn();
	});
});

describe("a message the engine refuses (isolated host)", () => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	for (const lane of ["steering", "follow-up"] as const) {
		test(`stops showing a refused ${lane} message as queued and gives it back to the editor (#4696)`, async () => {
			const toolHold = createGate();
			const rig = await createRig("isolated", "quiet", { tools: [holdTool(toolHold)] });
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("answered"),
			]);
			await rig.host.defaultEditor.onSubmit?.("first");
			await toolHold.entered.promise;
			await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
			rig.pair?.failCommand("prompt", "engine refused the message");

			const submitted =
				lane === "steering"
					? rig.host.defaultEditor.onSubmit?.("typed while busy")
					: pressAltEnter(rig.host, "typed while busy");
			assert.equal(queuedRows(rig).length, 1, "shown as queued while the engine answers");
			await submitted;

			assert.deepEqual(queuedRows(rig), []);
			assert.equal(rig.host.editor.getText(), "typed while busy");
			assert.ok(
				rig.host.notices.some((notice) => notice.includes("engine refused the message")),
				`the refusal is reported: ${JSON.stringify(rig.host.notices)}`,
			);
			toolHold.release.resolve();
		});
	}
});
