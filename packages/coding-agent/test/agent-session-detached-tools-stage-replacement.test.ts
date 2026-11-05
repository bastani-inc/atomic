/**
 * A workflow stage's replacement session waits for the stage runner's re-sent prompt, holding turn-starting input as
 * that prompt's context (#3982). Continuing a detached turn on it is the stage's run: input that arrives afterwards
 * starts its own turn (#4309).
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { detachedResult, harnessPool, persistedManager, waitForCiTurn, waitTool } from "./helpers/detached-tools.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const pool = harnessPool();
const stageHarnesses: Harness[] = [];
afterEach(async () => {
	while (stageHarnesses.length > 0) await stageHarnesses.pop()?.cleanup();
	await pool.cleanup();
});

/** The internal handoff the stage runner calls on a session it retires. */
interface StageSessionTransfer {
	transferWorkflowStageDeliveriesTo(target: object): void;
}

function stageContext() {
	const boundary = new WorkflowStageAdmissionBoundary();
	return {
		kind: "workflow-stage" as const,
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-r",
		workflowStageName: "Stage R",
		constraints: { disableWorkflowTool: true as const },
		messageAdmission: { boundary, extensionState: new Map<string, object>(), isOpen: () => boundary.isOpen() },
	};
}

test("a detached turn continued on a stage's replacement session ends its wait for a re-sent prompt (#4309)", async () => {
	const tool = waitTool();
	const { manager, store } = await persistedManager();
	const first = await pool.harnessWith([tool.definition], manager);
	first.session.setToolDetachment({ afterMs: 0 });
	first.setResponses([waitForCiTurn("ci-1")]);
	await first.session.prompt("watch ci");
	first.session.takeDetachedToolCalls();

	const context = stageContext();
	const retired = await createHarness({ orchestrationContext: context });
	stageHarnesses.push(retired);
	const replacement = await createHarness({
		orchestrationContext: context,
		sessionManager: await SessionManager.open(store, manager.getSessionId()),
		customTools: [tool.definition],
	});
	stageHarnesses.push(replacement);
	// The stage runner retires the stage's session into its replacement, as a model fallback does (#3982).
	(retired.session as unknown as StageSessionTransfer).transferWorkflowStageDeliveriesTo(replacement.session);
	replacement.setResponses([fauxAssistantMessage("ci passed"), fauxAssistantMessage("answered the peer")]);

	await replacement.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
	assert.equal(getMessageText(replacement.session.messages.at(-1)), "ci passed");

	await replacement.session.sendCustomMessage(
		{ customType: "intercom_message", content: "peer hello", display: true },
		{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: "intercom:after-resume" },
	);

	await vi.waitFor(() => assert.equal(replacement.getPendingResponseCount(), 0), { timeout: 5_000, interval: 20 });
	await replacement.session.agent.waitForIdle();
	assert.equal(getMessageText(replacement.session.messages.at(-1)), "answered the peer");
});
