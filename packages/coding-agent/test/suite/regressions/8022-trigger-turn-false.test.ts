import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * `triggerTurn: false` promises the caller that the message does not drive the
 * agent. Before this fix the generic streaming branch queued it as a steering
 * message anyway, so a status card sent during a turn silently became input the
 * model acted on.
 *
 * The message is appended as context after the turn's tool results instead. Since
 * provider requests are built from the canonical session projection, the appended
 * context is visible to the run's next request (after the tool results, never
 * between a tool call and its result) without being delivered as steering input.
 */

/** Index of the first user-role message carrying `text`, or -1. */
function indexOfUserText(messages: Array<{ role: string; content: unknown }>, text: string): number {
	return messages.findIndex(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) => typeof part === "object" && part !== null && "text" in part && String(part.text).startsWith(text),
			),
	);
}
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
		let appendedAfterToolResults = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const cardIndex = indexOfUserText(context.messages, "status only");
				const lastToolResultIndex = context.messages.map((message) => message.role).lastIndexOf("toolResult");
				// Steering would place the card between the tool call and its result.
				steeredIntoTurn = cardIndex !== -1 && cardIndex < lastToolResultIndex;
				appendedAfterToolResults = cardIndex !== -1 && cardIndex > lastToolResultIndex;
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
		expect(appendedAfterToolResults).toBe(true);
		// The card is recorded once and stays in model context.
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
		let appendedAfterToolResults = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const cardIndex = indexOfUserText(context.messages, "batch status");
				const lastToolResultIndex = context.messages.map((message) => message.role).lastIndexOf("toolResult");
				steeredIntoTurn = cardIndex !== -1 && cardIndex < lastToolResultIndex;
				appendedAfterToolResults = cardIndex !== -1 && cardIndex > lastToolResultIndex;
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
		expect(appendedAfterToolResults).toBe(true);
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
