import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../../../test/helpers/temporary-agent-dir.js";
import type { AgentSessionInternalSurface } from "../../../src/core/agent-session-methods.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

useTemporaryAgentDir();

type SessionInternals = Pick<
	AgentSessionInternalSurface,
	"_isPreparingRun" | "_flushPendingBashMessages" | "_runAgentPrompt" | "isStreaming"
>;

function recordedLevels(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "thinking_level_change" ? [entry.thinkingLevel] : []));
}

function branchShape(harness: Harness): string[] {
	return harness.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type === "thinking_level_change") return [`think:${entry.thinkingLevel}`];
		if (entry.type === "custom_message") return [`custom:${entry.customType}`];
		if (entry.type !== "message") return [];
		return [`${entry.message.role}:${getMessageText(entry.message)}`];
	});
}

/** high, prompt, low, prompt, then back to the first answer: the branch implies high while the session runs at low. */
async function divergedHarness(harnesses: Harness[], extraResponses: number): Promise<Harness> {
	const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage("one"),
		fauxAssistantMessage("two"),
		...Array.from({ length: extraResponses }, (_, i) => fauxAssistantMessage(`extra ${i}`)),
	]);
	const { session, sessionManager } = harness;
	await session.setThinkingLevel("high");
	await session.prompt("one");
	const firstAnswer = sessionManager.getLeafId()!;
	await session.setThinkingLevel("low");
	await session.prompt("two");
	await session.navigateTree(firstAnswer);
	return harness;
}

describe("pi #11451 thinking level after tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("records the live thinking level on the new branch before the next prompt", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const { session, sessionManager } = harness;

		await session.setThinkingLevel("high");
		await session.prompt("one");
		const firstAnswer = sessionManager.getLeafId()!;
		await session.setThinkingLevel("low");
		await session.prompt("two");
		await session.navigateTree(firstAnswer);
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("high");
		await session.prompt("three");

		expect(session.thinkingLevel).toBe("low");
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("low");
		expect(recordedLevels(harness)).toEqual(["high", "low"]);
		const branch = sessionManager.getBranch();
		const recordedAt = branch.findLastIndex((entry) => entry.type === "thinking_level_change");
		const promptAt = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(recordedAt).toBeLessThan(promptAt);
	});

	it("does not record the level again when the branch already holds it", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const { session } = harness;

		await session.setThinkingLevel("high");
		await session.prompt("one");
		await session.prompt("two");

		expect(recordedLevels(harness)).toEqual(["high"]);
	});

	it("does not start the prompt when the thinking level cannot be recorded", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const { session, sessionManager } = harness;

		await session.setThinkingLevel("high");
		await session.prompt("one");
		const firstAnswer = sessionManager.getLeafId()!;
		await session.setThinkingLevel("low");
		await session.prompt("two");
		await session.navigateTree(firstAnswer);
		const failure = new Error("thinking level write failed");
		const append = vi.spyOn(sessionManager, "appendThinkingLevelChange").mockRejectedValueOnce(failure);

		await expect(session.prompt("three")).rejects.toBe(failure);

		expect(append).toHaveBeenCalledWith("low");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not record a level when the branch holds none", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);

		await harness.session.prompt("one");

		expect(recordedLevels(harness)).toEqual([]);
	});

	it("does not record a level that only differs from the branch by clamping", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		const { session, sessionManager } = harness;

		await session.setThinkingLevel("high");
		await sessionManager.appendThinkingLevelChange("xhigh");
		await session.prompt("one");

		expect(recordedLevels(harness).at(-1)).toBe("xhigh");
	});

	const holds = ["the first thinking level write", "every thinking level write", "the run's message flush"] as const;

	async function sendCustomMessageWhilePromptPrepares(hold: (typeof holds)[number]) {
		const harness = await divergedHarness(harnesses, 2);
		const { session, sessionManager } = harness;
		const internals = session as unknown as SessionInternals;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const appendThinkingLevelChange = sessionManager.appendThinkingLevelChange.bind(sessionManager);
		const heldAppend = async (level: string) => {
			started.resolve();
			await release.promise;
			return appendThinkingLevelChange(level);
		};
		const appends = vi.spyOn(sessionManager, "appendThinkingLevelChange");
		if (hold === "the first thinking level write") appends.mockImplementationOnce(heldAppend);
		if (hold === "every thinking level write") appends.mockImplementation(heldAppend);
		if (hold === "the run's message flush") {
			const flush = internals._flushPendingBashMessages.bind(session);
			let flushes = 0;
			vi.spyOn(internals, "_flushPendingBashMessages").mockImplementation(async () => {
				flushes += 1;
				if (flushes === 2) {
					started.resolve();
					await release.promise;
				}
				return flush();
			});
		}

		const prompting = session.prompt("three");
		await started.promise;
		const preparingWhileHeld = internals.isStreaming || internals._isPreparingRun !== false;
		const sending = session.sendCustomMessage(
			{ customType: "note", content: "steered", display: true },
			{ triggerTurn: true },
		);
		release.resolve();
		await Promise.all([prompting, sending]);
		return {
			appends: appends.mock.calls.length,
			preparingWhileHeld,
			levels: recordedLevels(harness),
			shape: branchShape(harness),
			pendingResponses: harness.getPendingResponseCount(),
		};
	}

	it("keeps a turn-starting message in the prompt's run while the thinking level is written", async () => {
		const outcomes = [];
		for (const hold of holds) outcomes.push(await sendCustomMessageWhilePromptPrepares(hold));

		for (const [index, outcome] of outcomes.entries()) {
			expect(outcome.preparingWhileHeld, holds[index]).toBe(true);
			expect(outcome.appends, holds[index]).toBe(1);
			expect(outcome.levels, holds[index]).toEqual(["high", "low"]);
			expect(
				outcome.shape.filter((entry) => entry === "custom:note"),
				holds[index],
			).toHaveLength(1);
			expect(outcome.shape.lastIndexOf("think:low"), holds[index]).toBeLessThan(outcome.shape.indexOf("user:three"));
			expect(outcome.shape.indexOf("user:three"), holds[index]).toBeLessThan(outcome.shape.indexOf("custom:note"));
		}
		expect(outcomes[0]).toEqual(outcomes[2]);
		expect(outcomes[1]).toEqual(outcomes[2]);
	});

	it("does not record the level on a run that starts without preparation, such as the reload continuation", async () => {
		const harness = await divergedHarness(harnesses, 1);
		const { session, sessionManager } = harness;
		const internals = session as unknown as SessionInternals;
		const appends = vi.spyOn(sessionManager, "appendThinkingLevelChange");
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValueOnce(undefined);

		const running = internals._runAgentPrompt([] as AgentMessage[]);
		expect(agentPrompt).toHaveBeenCalledTimes(1);
		await running;

		expect(appends).not.toHaveBeenCalled();
		expect(recordedLevels(harness)).toEqual(["high"]);
		await session.prompt("three");
		expect(appends).toHaveBeenCalledTimes(1);
		expect(recordedLevels(harness)).toEqual(["high", "low"]);
	});

	it("does not record the level on interrupt delivery; the next prompt does", async () => {
		const harness = await divergedHarness(harnesses, 2);
		const { session, sessionManager } = harness;
		const appends = vi.spyOn(sessionManager, "appendThinkingLevelChange");

		await session.sendCustomMessage(
			{ customType: "alert", content: "now", display: true },
			{ deliverAs: "interrupt", triggerTurn: true },
		);
		await (session as unknown as Pick<AgentSessionInternalSurface, "_interruptDeliveryQueue">)
			._interruptDeliveryQueue;

		expect(branchShape(harness)).toContain("custom:alert");
		expect(appends).not.toHaveBeenCalled();
		await session.prompt("three");
		expect(appends).toHaveBeenCalledTimes(1);
		expect(recordedLevels(harness)).toEqual(["high", "low"]);
	});
});
