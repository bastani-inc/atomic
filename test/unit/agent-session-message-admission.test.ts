import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	sendCustomMessage,
	sendCustomMessages,
} from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import type { StageAdmittedCustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager-core.ts";

describe("AgentSession message admission", () => {
	test("message admission identity survives the session-manager round trip", async () => {
		const manager = SessionManager.inMemory();
		await manager.appendCustomMessageEntry(
			"subagent-notify",
			"result",
			true,
			undefined,
			undefined,
			undefined,
			"subagent:job-1",
		);
		const message = manager.buildSessionContext().messages[0] as StageAdmittedCustomMessage | undefined;
		assert.equal(message?.stageAdmissionKey, "subagent:job-1");
	});

	test("single and batched admitted messages retain their admission identity", async () => {
		const captured: Array<{
			readonly stageAdmissionKey?: string;
		}> = [];
		const surface = {
			sessionManager: SessionManager.inMemory(),
			isStreaming: false,
			_appendCustomMessage(message: { readonly stageAdmissionKey?: string }) {
				captured.push(message);
			},
		};
		await sendCustomMessage.call(
			surface as never,
			{ customType: "subagent-notify", content: "one", display: true },
			{ stageAdmissionKey: "subagent:one" },
		);
		await sendCustomMessages.call(
			surface as never,
			[
				{ customType: "subagent-notify", content: "two", display: true },
				{ customType: "subagent-notify", content: "three", display: true },
			],
			{ stageAdmissionKey: "subagent:batch" },
		);
		assert.deepEqual(
			captured.map((message) => message.stageAdmissionKey),
			["subagent:one", "subagent:batch#0", "subagent:batch"],
		);
	});

	test("custom-message completion is an admission receipt rather than model-turn completion", async () => {
		const turn = Promise.withResolvers<void>();
		const admitted: string[] = [];
		const surface = {
			isStreaming: false,
			_pendingNextTurnMessages: [],
			_queueAgentMessage() {},
			_appendCustomMessage() {},
			async _enqueueInterruptCustomMessage() {},
			_runAgentPrompt(message: { content: string | object[] }, started?: () => void) {
				if (typeof message.content === "string") admitted.push(message.content);
				started?.();
				return turn.promise;
			},
		};

		await sendCustomMessage.call(
			surface as never,
			{
				customType: "intercom_message",
				content: "accepted",
				display: true,
			},
			{ triggerTurn: true },
		);
		assert.deepEqual(admitted, ["accepted"]);
		turn.reject(new Error("later model turn failure"));
		await Promise.resolve();
	});
});
