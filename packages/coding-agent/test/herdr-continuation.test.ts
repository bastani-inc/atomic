import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";
import { createHarnessWithExtensions, fauxModel } from "./test-harness.js";

test("repeated output-cap continuations stay working across quiet waits and settle only after the final response", async () => {
	const fake = await fakeHerdr();
	let finishResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		finishResponse = resolve;
	});
	let requestFinalResponse!: () => void;
	const finalResponseRequested = new Promise<void>((resolve) => {
		requestFinalResponse = resolve;
	});
	let completedReports = 1; // Initial idle, then one working report per low-level run.
	const harness = await createHarnessWithExtensions({
		model: { ...fauxModel, maxTokens: 20 },
		settings: { compaction: { enabled: true }, sessionSummary: { enabled: false } },
		responses: [
			{ text: "First partial", stopReason: "length", usage: { output: 20 } },
			{ text: "Second partial", stopReason: "length", usage: { output: 20 } },
			{
				text: "Final answer",
				beforeEmit: () => {
					requestFinalResponse();
					return responseGate;
				},
			},
		],
		extensionFactories: [
			createHerdrExtension({ env: fake.env, enabled: () => true }),
			(pi) => {
				pi.registerWorkflowActivityPublisher().publishSnapshot({ availability: "ready", roots: [] });
				pi.on("agent_start", async () => {
					await fake.waitFor(++completedReports);
				});
			},
		],
	});
	let turn: Promise<void> | undefined;
	try {
		await harness.session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
		await fake.waitFor(1);
		let settled = false;
		turn = harness.session.prompt("Continue until complete").then(() => {
			settled = true;
		});
		// Each continuation first waits for a real fake-Herdr child: wait for the third model request
		// itself, or for the prompt to settle without it, rather than for a polling budget.
		await Promise.race([finalResponseRequested, turn]);
		assert.equal(harness.faux.callCount, 3);
		await fake.waitFor(4);
		const during = (await fake.calls()).filter((call) => call.phase === "start");
		assert.ok(
			during.slice(1).every((call) => arg(call.args, "--state") === "working"),
			JSON.stringify(during),
		);
		assert.equal(settled, false, "the prompt still owns the silent final continuation");
		assert.equal(harness.eventsOfType("agent_settled").length, 0);
		// No stream events for fifteen virtual minutes: elapsed silence is not settlement
		// and must not need heartbeat reports. Only the provider gate can finish this turn.
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		await vi.advanceTimersByTimeAsync(15 * 60_000);
		vi.useRealTimers();
		assert.equal(settled, false);
		assert.equal(harness.eventsOfType("agent_settled").length, 0);
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start"),
			during,
		);
		finishResponse();
		await turn;
		assert.equal(harness.eventsOfType("agent_settled").length, 1);
		const reports = await fake.waitFor(5);
		assert.equal(arg(reports.at(-1)!.args, "--state"), "idle");
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		for (const [index, call] of calls.entries()) {
			assert.equal(arg(call.args, "--source"), "custom:atomic");
			if (index) assert.ok(Number(arg(call.args, "--seq")) > Number(arg(calls[index - 1].args, "--seq")));
		}
	} finally {
		finishResponse();
		vi.useRealTimers();
		await turn;
		await harness.session.abort();
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		await fake.dispose();
	}
});
