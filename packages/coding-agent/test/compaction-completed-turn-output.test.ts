import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai";
import { afterEach, describe, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.js";
import { createHarness, type Harness } from "./suite/harness.ts";

const WINDOW = 1_000_000;
/** About 984k tokens: the provider reports usage from what it was sent, so the answer crosses the trigger. */
const LARGE_PROMPT = `long task\n${"word ".repeat(787_000)}`;
const ANSWER = "CURRENT-FINAL-ANSWER";

function roles(context: { messages: Array<{ role: string }> }): string[] {
	return context.messages.map((message) => message.role);
}

describe("a completed turn keeps its answer for its readers", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	async function largeTurn(): Promise<Harness> {
		const created = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384 }, retry: { enabled: false } },
		});
		return created;
	}

	it("a threshold-crossing answer is still the last answer after the prompt resolves, and the clear runs before the next request", async () => {
		harness = await largeTurn();
		const contexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(ANSWER),
			(context) => {
				contexts.push(roles(context));
				return fauxAssistantMessage("next answer");
			},
		]);
		await harness.session.prompt(LARGE_PROMPT);

		assert.equal(harness.session.getLastAssistantText(), ANSWER);
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
		assert.equal(harness.faux.state.callCount, 1);

		await harness.session.prompt("next");
		const branch = harness.sessionManager.getBranch();
		const boundary = branch.findIndex((entry) => entry.type === "compaction");
		const next = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes('"next"'),
		);
		assert.ok(boundary >= 0 && boundary < next, "the boundary precedes the next prompt");
		assert.deepEqual(contexts, [["system", "user", "user"]], "the next request carries the boundary and the prompt");
		assert.equal(harness.faux.state.callCount, 2, "the clear made no model call");
		assert.equal(harness.session.getLastAssistantText(), "next answer");
	});

	it("RPC get_last_assistant_text returns the current answer after a threshold-crossing turn", async () => {
		harness = await largeTurn();
		harness.setResponses([fauxAssistantMessage(ANSWER)]);
		await harness.session.prompt(LARGE_PROMPT);
		const handle = createRpcCommandHandler({
			runtimeHost: { session: harness.session, services: { agentDir: harness.tempDir } } as AgentSessionRuntime,
			getSession: () => harness!.session,
			rebindSession: async () => {},
			output: () => {},
			keybindings: KeybindingsManager.create(harness.tempDir),
			taskInspectorUi: { custom: async () => undefined as never },
		});
		const response = await handle({ id: "1", type: "get_last_assistant_text" } as RpcCommand);
		assert.deepEqual((response as { data?: { text?: string } }).data, { text: ANSWER });
	});

	it("a queued follow-up after a threshold-crossing answer goes out after a clear", async () => {
		harness = await largeTurn();
		const contexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(ANSWER),
			(context) => {
				contexts.push(roles(context));
				return fauxAssistantMessage("follow-up answer");
			},
		]);
		await harness.session.prompt(LARGE_PROMPT);
		harness.session.agent.followUp({ role: "user", content: "and one more thing", timestamp: Date.now() });
		await harness.session._continueQueuedAgentMessages();

		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.deepEqual(contexts, [["system", "user", "user"]], JSON.stringify(contexts));
		assert.equal(harness.session.getLastAssistantText(), "follow-up answer");
	});

	it("input queued while the session is idle after a threshold-crossing answer goes out after a clear", async () => {
		harness = await largeTurn();
		const contexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(ANSWER),
			(context) => {
				contexts.push(roles(context));
				return fauxAssistantMessage("queued answer");
			},
		]);
		await harness.session.prompt(LARGE_PROMPT);

		await harness.session.followUp("one more thing");
		await vi.waitFor(() => assert.equal(harness?.session.getLastAssistantText(), "queued answer"));

		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.deepEqual(contexts, [["system", "user", "user"]]);
		assert.equal(harness.faux.state.callCount, 2, "the clear made no model call");
	});

	it("an interrupt delivery after a threshold-crossing answer goes out after a clear", async () => {
		harness = await largeTurn();
		const contexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(ANSWER),
			(context) => {
				contexts.push(roles(context));
				return fauxAssistantMessage("woken answer");
			},
		]);
		await harness.session.prompt(LARGE_PROMPT);

		await harness.session.sendCustomMessage(
			{ customType: "intercom", content: "wake", display: true },
			{ deliverAs: "interrupt", triggerTurn: true },
		);
		await vi.waitFor(() => assert.equal(harness?.session.getLastAssistantText(), "woken answer"));

		const branch = harness.sessionManager.getBranch();
		const boundary = branch.findIndex((entry) => entry.type === "compaction");
		const wake = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === "intercom");
		assert.ok(boundary >= 0 && boundary < wake, "the boundary precedes the interrupt message");
		assert.deepEqual(contexts, [["system", "user", "user"]]);
		assert.equal(harness.faux.state.callCount, 2, "the clear made no model call");
	});

	it("the last answer is still readable after a manual compaction", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage(ANSWER)]);
		await harness.session.prompt("task");
		await harness.session.compact();
		assert.equal(harness.session.getLastAssistantText(), ANSWER);
	});

	function assistantEntryIds(opened: Harness): string[] {
		return opened.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []));
	}

	async function applyContextEdit(
		opened: Harness,
		targetId: string,
		replacement: { content: string } | null,
	): Promise<void> {
		await opened.sessionManager.appendContextEdit(targetId, replacement);
		opened.session.agent.state.messages = opened.sessionManager.buildSessionContext().messages;
	}

	it("the last answer after a compaction is the edited answer the model saw", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage("CURRENT-ANSWER-2")]);
		await harness.session.prompt("task");
		const [answer] = assistantEntryIds(harness);
		await applyContextEdit(harness, answer, { content: "EDITED-ANSWER" });
		assert.equal(harness.session.getLastAssistantText(), "EDITED-ANSWER");

		await harness.session.compact();

		assert.equal(harness.session.getLastAssistantText(), "EDITED-ANSWER");
	});

	it("the last answer after a compaction skips an answer omitted from context", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage("FIRST-ANSWER"), fauxAssistantMessage("SECOND-ANSWER")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const [, second] = assistantEntryIds(harness);
		await applyContextEdit(harness, second, null);
		assert.equal(harness.session.getLastAssistantText(), "FIRST-ANSWER");

		await harness.session.compact();

		assert.equal(harness.session.getLastAssistantText(), "FIRST-ANSWER");
	});
});
