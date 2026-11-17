import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../src/core/agent-session-persistent-custom-messages.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession custom-message batch admission", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each([false, true])("retries a partially saved batch once while paused=%s (#5342)", async (paused) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("noted")));
		if (paused) harness.session.pauseQueuedMessages();
		const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
		let writes = 0;
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
			if (args[0].startsWith("batch-") && ++writes === 2) throw new Error("SQLITE_BUSY");
			return append(...args);
		});
		const messages = [
			{ customType: "batch-a", content: "first result", display: true },
			{ customType: "batch-b", content: "second result", display: true },
		];
		const options = { triggerTurn: true, persistWhenStreaming: true, stageAdmissionKeys: ["batch-a", "batch-b"] };
		await expect(harness.session.sendCustomMessages(messages, options)).rejects.toThrow("SQLITE_BUSY");
		if (!paused) {
			await vi.waitFor(() =>
				expect(
					harness.sessionManager
						.getEntries()
						.filter(
							(entry) =>
								entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
						),
				).toHaveLength(1),
			);
		}
		await harness.session.agent.waitForIdle();
		await harness.session.sendCustomMessages(messages, options);
		if (paused) {
			await harness.session.resumeQueuedMessages();
			await harness.session.prompt("consume the held results");
		}
		await vi.waitFor(() =>
			expect(
				harness.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
					),
			).toHaveLength(2),
		);
		await harness.session.agent.waitForIdle();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		const cards = entries.filter((entry) => entry.customType.startsWith("batch-"));
		expect(cards.map((entry) => entry.customType)).toEqual(["batch-a", "batch-b"]);
		const reconciliations = entries.filter((entry) => entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE);
		expect(
			reconciliations
				.map((entry) => (entry.details as { protectedReconciliationOf: string }).protectedReconciliationOf)
				.sort(),
		).toEqual(cards.map((entry) => entry.id).sort());
	});

	it("starts the saved prefix if a pause is released before a later batch write fails (#5342)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("read the first result")]);
		harness.session.pauseQueuedMessages();
		const entered = Promise.withResolvers<void>();
		const fail = Promise.withResolvers<void>();
		const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
			if (args[0] === "batch-b") {
				entered.resolve();
				await fail.promise;
				throw new Error("SQLITE_BUSY");
			}
			return append(...args);
		});
		const delivery = harness.session.sendCustomMessages(
			[
				{ customType: "batch-a", content: "first result", display: true },
				{ customType: "batch-b", content: "second result", display: true },
			],
			{ triggerTurn: true, persistWhenStreaming: true },
		);
		const rejected = expect(delivery).rejects.toThrow("SQLITE_BUSY");
		try {
			await entered.promise;
			await harness.session.resumeQueuedMessages();
		} finally {
			fail.resolve();
		}
		await rejected;
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await harness.session.agent.waitForIdle();
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
				),
		).toHaveLength(1);
	});

	it("keeps a protected streaming batch contiguous, ordered, and durable", async () => {
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
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
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		await harness.session.sendCustomMessages(
			[
				{ customType: "batch-a1", content: "A1", display: true },
				{ customType: "batch-a2", content: "A2", display: true },
				{ customType: "batch-terminal", content: "terminal", display: true },
			],
			{ triggerTurn: true, persistWhenStreaming: true },
		);
		await harness.session.sendCustomMessage({ customType: "unrelated-b", content: "B", display: true });
		releaseTool?.();
		await promptPromise;

		const customTypes = harness.session.messages
			.filter((message) => message.role === "custom" && message.display !== false)
			.map((message) => message.customType);
		expect(customTypes).toEqual(["batch-a1", "batch-a2", "batch-terminal", "unrelated-b"]);
		const durableTypes = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message")
			.map((entry) => entry.customType);
		expect(durableTypes).toEqual([
			"batch-a1",
			"batch-a2",
			"batch-terminal",
			PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			"unrelated-b",
		]);
	});
});
