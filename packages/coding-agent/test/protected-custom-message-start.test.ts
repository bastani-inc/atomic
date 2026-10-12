import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import { fauxAssistantMessage, type TranscriptContext } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

test.each(["followUp", "interrupt"] as const)(
	"protected idle %s applies the custom starter hook once",
	async (deliverAs) => {
		const starters: string[] = [];
		const requests: TranscriptContext[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.messageType === "custom") starters.push(event.message.customType);
						return {
							systemPrompt: "protected starter system prompt",
							message: { customType: "hook-context", content: "hook supplied context", display: false },
						};
					});
				},
			],
		});
		try {
			(
				harness.session as AgentSession & { _workflowStageAdmission: WorkflowStageAdmissionBoundary }
			)._workflowStageAdmission = new WorkflowStageAdmissionBoundary();
			harness.setResponses([
				(context) => {
					requests.push(context);
					return fauxAssistantMessage("done");
				},
			]);
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "agent_settled") {
						unsubscribe();
						resolve();
					}
				});
			});
			await harness.session.sendCustomMessage(
				{ customType: "protected-starter", content: "protected task", display: true },
				{ triggerTurn: true, persistWhenStreaming: true, deliverAs },
			);
			await settled;
			assert.deepEqual(starters, ["protected-starter"]);
			assert.ok(requests.length > 0);
			assert.equal(getCurrentSystemPrompt(requests[0]!.messages), "protected starter system prompt");
			assert.ok(
				requests.some((request) =>
					request.messages.some((message) => getMessageText(message).includes("hook supplied context")),
				),
			);
			const cards = harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "protected-starter");
			assert.equal(cards.length, 1);
		} finally {
			await harness.cleanup();
		}
	},
);
