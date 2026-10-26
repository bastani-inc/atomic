import assert from "node:assert/strict";
import { fauxAssistantMessage, type TranscriptContext } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { createHarness, getMessageText } from "./suite/harness.js";

function stageContext() {
	const boundary = new WorkflowStageAdmissionBoundary();
	return {
		kind: "workflow-stage" as const,
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-b",
		workflowStageName: "Stage B",
		constraints: { disableWorkflowTool: true as const },
		messageAdmission: { boundary, extensionState: new Map<string, object>(), isOpen: () => boundary.isOpen() },
	};
}

const peerMessage = (text: string) => ({ customType: "intercom_message", content: text, display: true });
const peerOptions = (id: string, deliverAs?: "interrupt") => ({
	triggerTurn: true,
	persistWhenStreaming: true,
	stageAdmissionKey: `intercom:${id}`,
	...(deliverAs ? { deliverAs } : {}),
});

function requestTexts(request: TranscriptContext): string[] {
	return request.messages.map((message) => getMessageText(message));
}

test.each([undefined, "interrupt"] as const)(
	"issue #3982: a %s delivery forwarded to a fallback replacement does not reject the replacement's stage prompt",
	async (deliverAs) => {
		const context = stageContext();
		const retired = await createHarness({ orchestrationContext: context });
		// A replacement whose branch already holds conversation (a forked stage) is not a fresh stage session.
		const inherited = SessionManager.inMemory();
		await inherited.appendMessage({ role: "user", content: "inherited fork context", timestamp: Date.now() });
		const replacement = await createHarness({ orchestrationContext: context, sessionManager: inherited });
		const requests: TranscriptContext[] = [];
		try {
			const respond = (request: TranscriptContext) => {
				requests.push(request);
				return fauxAssistantMessage("stage done");
			};
			replacement.setResponses([respond, respond, respond]);
			retired.session.transferWorkflowStageDeliveriesTo(replacement.session);

			await retired.session.sendCustomMessage(peerMessage("sibling hello"), peerOptions("a", deliverAs));
			await replacement.session.prompt("stage fallback prompt");
			await replacement.session.agent.waitForIdle();

			assert.ok(requests.length >= 1);
			const texts = requestTexts(requests[0]!);
			const promptIndex = texts.findIndex((text) => text.includes("stage fallback prompt"));
			const peerIndex = texts.findIndex((text) => text.includes("sibling hello"));
			assert.ok(promptIndex >= 0, "the replacement's first turn carries the stage prompt");
			assert.ok(peerIndex >= 0 && peerIndex < promptIndex, "the forwarded delivery is context before the prompt");
		} finally {
			await replacement.cleanup();
			await retired.cleanup();
		}
	},
);
