/**
 * `session.release()` of a workflow stage's session (#4326): the stage's task host, which outlives the session, lets go
 * of it, while a subagent child launched from the stage leaves the stage's live session bound when it is released.
 */
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { WorkflowStageOrchestrationContext } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./suite/harness.ts";

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

async function collected(released: WeakRef<object>): Promise<boolean> {
	for (let round = 0; round < 10; round++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (released.deref() === undefined) return true;
	}
	return false;
}

const harnesses: Harness[] = [];
const boundaries: WorkflowStageAdmissionBoundary[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (boundaries.length > 0) await boundaries.pop()?.close();
});

function stageContext(): WorkflowStageOrchestrationContext {
	return {
		kind: "workflow-stage",
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-a",
		workflowStageName: "Stage A",
		constraints: { disableWorkflowTool: true },
	};
}

function boundaryOf(context: WorkflowStageOrchestrationContext): WorkflowStageAdmissionBoundary {
	const boundary = context.messageAdmission?.boundary;
	assert.ok(boundary !== undefined, "the stage's first session gave the stage its admission boundary");
	return boundary;
}

async function storedHarness(options: HarnessOptions): Promise<Harness> {
	return createHarness({
		...options,
		sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd()),
	});
}

const bashTurn = (id: string, text: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${text}` }, { id })], { stopReason: "toolUse" });

describe("releasing a workflow stage's session (#4326)", () => {
	test("a stage session that ran a task is collected once released, though the stage's task host lives on (#4326)", async () => {
		const context = stageContext();

		async function ranBashThenReleased(): Promise<WeakRef<object>> {
			const harness = await storedHarness({ orchestrationContext: context });
			harness.setResponses([bashTurn("bash-1", "stage"), fauxAssistantMessage("done")]);
			await harness.session.prompt("run it");
			assert.equal(boundaryOf(context).hasAgentTaskHost(), true, "bash bound the stage's task host");
			await harness.session.release();
			const released = new WeakRef<object>(harness.session);
			await harness.cleanup();
			return released;
		}

		const released = await ranBashThenReleased();
		boundaries.push(boundaryOf(context));

		assert.equal(await collected(released), true, "the released stage session was collected");
	});

	test("a subagent child launched from the stage leaves the stage's session able to run tasks when it is released (#4326)", async () => {
		const context = stageContext();
		const stage = await storedHarness({ orchestrationContext: context });
		harnesses.push(stage);
		boundaries.push(boundaryOf(context));
		stage.setResponses([bashTurn("bash-1", "before"), fauxAssistantMessage("ran it")]);
		await stage.session.prompt("run it");
		const child = await storedHarness({
			orchestrationContext: context,
			subagentPolicy: {
				depth: 1,
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: false,
				inheritSkills: false,
			},
		});
		harnesses.push(child);

		await child.session.release();

		stage.setResponses([bashTurn("bash-2", "after-child-release"), fauxAssistantMessage("ran it again")]);
		await stage.session.prompt("run it again");
		const result = stage.eventsOfType("tool_execution_end").find((event) => event.toolCallId === "bash-2");
		assert.equal(result?.isError, false, "the stage's task host still launches the stage's tasks");
		assert.match(getMessageText(result?.result), /after-child-release/);
	});
});
