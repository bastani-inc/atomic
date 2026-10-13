import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
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
					const queued = mode === "followUp" ? session.getFollowUpMessages() : session.getSteeringMessages();
					assert.deepEqual([...getUserTexts(harness), ...queued], [...(midTurn ? ["start"] : []), "A", "A2", "B"]);
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
