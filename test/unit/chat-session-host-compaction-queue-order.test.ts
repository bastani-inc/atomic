import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { beforeAll, test, vi } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.ts";
import { editorTheme, plainStyle } from "./chat-session-host-working-lifecycle-fixture.ts";

beforeAll(() => initTheme("dark", false));

for (const mode of ["auto", "followUp"] as const) {
	for (const aborted of [false, true]) {
		for (const midTurn of [true, false]) {
			test(`ChatSessionHost releases held ${mode} messages in order when ${midTurn ? "mid-turn" : "idle manual"} compaction ${aborted ? "aborts" : "finishes"}`, async () => {
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const waitTool: AgentTool = {
					name: "wait",
					label: "Wait",
					description: "Wait for release",
					parameters: Type.Object({}),
					execute: async () => {
						started.resolve();
						await release.promise;
						return { content: [{ type: "text", text: "released" }], details: {} };
					},
				};
				const harness = await createHarness({
					tools: [waitTool],
					settings: { compaction: { enabled: false } },
				});
				const { session } = harness;
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("continued"),
					fauxAssistantMessage("A received"),
					fauxAssistantMessage("A2 received"),
					fauxAssistantMessage("B received"),
				]);
				let running: Promise<void> | undefined;
				const host = new ChatSessionHost({
					style: plainStyle,
					editorTheme,
					getAgentSession: () => session,
					isStreaming: () => session.isStreaming,
					commands: {
						prompt: (text, submitMode) => {
							running = session.prompt(text, {
								streamingBehavior: submitMode === "followUp" ? "followUp" : "steer",
							});
							return running;
						},
						followUp: async (text) => {
							await session.followUp(text);
						},
						steer: async (text) => {
							await session.steer(text);
						},
					},
				});
				const unsubscribe = session.subscribe((event) => host.applyAgentEvent(event));
				const reason = midTurn ? "threshold" : "manual";
				try {
					if (midTurn) {
						running = session.prompt("start");
						await started.promise;
					}
					host.applyAgentEvent({ type: "compaction_start", reason, midTurn });
					await host.submit(mode, "A");
					await host.submit(mode, "A2");
					assert.match(host.renderPendingMessages(80).join("\n"), /A2/);
					assert.deepEqual(getUserTexts(harness), midTurn ? ["start"] : []);
					host.applyAgentEvent({
						type: "compaction_end",
						reason,
						midTurn,
						result: undefined,
						aborted,
						willRetry: false,
					});
					if (!midTurn) await started.promise;
					await host.submit(mode, "B");
					const queued = () =>
						mode === "followUp" ? session.getFollowUpMessages() : session.getSteeringMessages();
					await vi.waitFor(() =>
						assert.deepEqual(
							[...getUserTexts(harness), ...queued()],
							[...(midTurn ? ["start"] : []), "A", "A2", "B"],
						),
					);
					release.resolve();
					await running;
					await session.agent.waitForIdle();
					assert.deepEqual(getUserTexts(harness), [...(midTurn ? ["start"] : []), "A", "A2", "B"]);
				} finally {
					release.resolve();
					await running;
					unsubscribe();
					host.dispose();
					await harness.cleanup();
				}
			});
		}
	}
}

async function hostWithHeldBatch() {
	const firstPrompt = Promise.withResolvers<void>();
	const prompts: string[] = [];
	const steers: string[] = [];
	const bashCommands: string[] = [];
	const resumed: (string | undefined)[] = [];
	let paused = false;
	const host = new ChatSessionHost({
		style: plainStyle,
		editorTheme,
		isStreaming: () => false,
		isPaused: () => paused,
		commands: {
			prompt: (text) => {
				prompts.push(text);
				return firstPrompt.promise;
			},
			steer: async (text) => {
				steers.push(text);
			},
			runBash: async ({ command }) => {
				bashCommands.push(command);
				return { output: "", exitCode: 0, cancelled: false, truncated: false };
			},
			resume: async (message) => {
				resumed.push(message);
			},
		},
	});
	host.applyAgentEvent({ type: "compaction_start", reason: "manual" });
	for (const text of ["A", "B", "C"]) await host.submit("auto", text);
	host.applyAgentEvent({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	const typedDuringHandOff = host.submit("auto", "D");
	const pause = () => {
		paused = true;
	};
	return { host, firstPrompt, prompts, steers, bashCommands, resumed, pause, typedDuringHandOff };
}

async function hostAfterFailedBatch() {
	const held = await hostWithHeldBatch();
	await held.typedDuringHandOff;
	held.firstPrompt.reject(new Error("send failed"));
	await vi.waitFor(() => assert.match(held.host.statusText(), /send failed/));
	return held;
}

function restoredOrder(host: ChatSessionHost): string[] {
	assert.equal(host.restoreQueuedMessagesToEditor(), true);
	return host
		.inputText()
		.split(/\s+/)
		.filter((text) => text.length > 0);
}

test("ChatSessionHost restores a failed post-compaction batch in typed order ahead of later input (#3664)", async () => {
	const { host, firstPrompt, prompts, steers, typedDuringHandOff } = await hostWithHeldBatch();
	try {
		await typedDuringHandOff;
		assert.deepEqual(steers, [], "the batch waits until its first prompt is accepted");
		firstPrompt.reject(new Error("send failed"));
		await vi.waitFor(() => assert.match(host.renderPendingMessages(80).join("\n"), /A/));
		assert.deepEqual(prompts, ["A"]);
		assert.deepEqual(steers, []);
		assert.deepEqual(restoredOrder(host), ["A", "B", "C", "D"]);
	} finally {
		host.dispose();
	}
});

test("ChatSessionHost queues the rest of the batch and later input in order once its first prompt starts (#3664)", async () => {
	const { host, firstPrompt, steers, typedDuringHandOff } = await hostWithHeldBatch();
	try {
		await typedDuringHandOff;
		host.applyAgentEvent({ type: "agent_start" });
		await vi.waitFor(() => assert.deepEqual(steers, ["B", "C", "D"]));
		firstPrompt.reject(new Error("run failed"));
		await vi.waitFor(() => assert.match(host.statusText(), /run failed/));
		assert.equal(host.restoreQueuedMessagesToEditor(), false, "an accepted prompt is not restored");
	} finally {
		host.dispose();
	}
});

test("ChatSessionHost still runs shell input while a failed post-compaction batch is held (#3664)", async () => {
	const { host, bashCommands, steers } = await hostAfterFailedBatch();
	try {
		await host.submit("auto", "!git status");
		assert.deepEqual(bashCommands, ["git status"]);
		assert.deepEqual(steers, []);
		assert.deepEqual(restoredOrder(host), ["A", "B", "C", "D"]);
	} finally {
		host.dispose();
	}
});

test("ChatSessionHost resumes a paused session instead of holding the next submission (#3664)", async () => {
	const { host, resumed, pause } = await hostAfterFailedBatch();
	try {
		pause();
		await host.submit("auto", "next");
		assert.deepEqual(resumed, ["next"]);
	} finally {
		host.dispose();
	}
});
