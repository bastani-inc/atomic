import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * `triggerTurn: false` promises the caller that the message does not drive the
 * agent. Before this fix the generic streaming branch queued it as a steering
 * message anyway, so a status card sent during a turn silently became input the
 * model acted on.
 */
async function createWaitingHarness(): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

function sawText(harness: Harness, text: string): boolean {
	return convertToLlm(harness.session.messages).some(
		(message) =>
			message.role === "user" &&
			typeof message.content !== "string" &&
			message.content.some((part) => part.type === "text" && part.text === text),
	);
}

describe("regression #8022: triggerTurn false never steers an active run", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends a single custom message instead of steering the streaming turn", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		let steeredIntoTurn = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				steeredIntoTurn = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "status only"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "trigger-turn-test", content: "status only", display: true, details: { value: 1 } },
			{ triggerTurn: false },
		);
		releaseToolExecution();
		await promptPromise;

		expect(steeredIntoTurn).toBe(false);
		// The card is still recorded and still reaches the model on a later turn.
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "trigger-turn-test",
			),
		).toHaveLength(1);
		expect(sawText(harness, "status only")).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("appends a batch instead of steering the streaming turn", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		let steeredIntoTurn = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				steeredIntoTurn = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text.startsWith("batch status")),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessages(
			[
				{ customType: "trigger-turn-test", content: "batch status 1", display: true, details: { value: 1 } },
				{ customType: "trigger-turn-test", content: "batch status 2", display: true, details: { value: 2 } },
			],
			{ triggerTurn: false },
		);
		releaseToolExecution();
		await promptPromise;

		expect(steeredIntoTurn).toBe(false);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "trigger-turn-test",
			),
		).toHaveLength(2);
		expect(sawText(harness, "batch status 1")).toBe(true);
		expect(sawText(harness, "batch status 2")).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("still steers when triggerTurn is left unset", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		let steeredIntoTurn = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				steeredIntoTurn = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer me"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage({
			customType: "trigger-turn-test",
			content: "steer me",
			display: true,
			details: { value: 1 },
		});
		releaseToolExecution();
		await promptPromise;

		expect(steeredIntoTurn).toBe(true);
	});
});
