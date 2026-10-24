import assert from "node:assert/strict";
import { fauxAssistantMessage, type TranscriptContext } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

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

test("issue #3919: intercom sends that reach a stage before its first prompt become context for the stage prompt's turn", async () => {
	const requests: TranscriptContext[] = [];
	const harness = await createHarness({ orchestrationContext: stageContext() });
	try {
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("stage done");
			},
		]);
		await harness.session.sendCustomMessage(peerMessage("sibling interrupt hello"), peerOptions("a", "interrupt"));
		await harness.session.sendCustomMessage(peerMessage("sibling send hello"), peerOptions("b"));

		await harness.session.prompt("stage task prompt");

		assert.equal(requests.length, 1, "only the stage prompt starts a model turn");
		const texts = requestTexts(requests[0]!);
		const promptIndex = texts.findIndex((text) => text.includes("stage task prompt"));
		assert.ok(promptIndex >= 0, "the first turn carries the stage prompt");
		for (const early of ["sibling interrupt hello", "sibling send hello"]) {
			const index = texts.findIndex((text) => text.includes(early));
			assert.ok(index >= 0 && index < promptIndex, `${early} is context before the stage prompt`);
		}
	} finally {
		await harness.cleanup();
	}
});

test("issue #3919: an intercom send arriving while the stage prompt is being sent does not reject the prompt", async () => {
	const requests: TranscriptContext[] = [];
	let sent = false;
	const harness = await createHarness({
		orchestrationContext: stageContext(),
		extensionFactories: [
			(pi) => {
				pi.on("input", async () => {
					if (sent) return { action: "continue" as const };
					sent = true;
					await pi.sendMessage(peerMessage("sibling mid-prompt hello"), peerOptions("c", "interrupt"));
					return { action: "continue" as const };
				});
			},
		],
	});
	try {
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("stage done");
			},
		]);

		await harness.session.prompt("stage task prompt");

		assert.ok(sent);
		assert.ok(requests.length >= 1);
		const texts = requestTexts(requests[0]!);
		assert.ok(
			texts.some((text) => text.includes("stage task prompt")),
			"the first turn carries the stage prompt",
		);
		assert.ok(
			requests.some((request) => requestTexts(request).some((text) => text.includes("sibling mid-prompt hello"))),
			"the mid-prompt message is not dropped",
		);
	} finally {
		await harness.cleanup();
	}
});
