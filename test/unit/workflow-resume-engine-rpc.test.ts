import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type {
	ExtensionCommandContext,
	HostSessionPickerRow,
} from "../../packages/coding-agent/src/core/extensions/index.js";
import { WorkflowRunControlUnavailableError } from "../../packages/coding-agent/src/core/extensions/workflow-run-control.js";
import {
	deleteWorkflowFromPicker,
	listWorkflowResumeEntries,
	resumeWorkflowFromPicker,
} from "../../packages/coding-agent/src/core/workflow-resume.js";
import { sessionInfoFromPickerRow } from "../../packages/coding-agent/src/modes/interactive/components/host-session-picker.js";
import { parseInteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function sampleRow(overrides: Partial<HostSessionPickerRow> = {}): HostSessionPickerRow {
	return {
		path: "workflow-durable:wf-123",
		id: "wf-123",
		cwd: "/work/project",
		createdAt: 1_700_000_000_000,
		modifiedAt: 1_700_000_060_000,
		messageCount: 3,
		firstMessage: "ralph · fix shipping benchmark",
		title: "ralph · fix shipping benchmark",
		detail: "paused · stage 3/5 implement · 2h ago · 41m · $1.84 · feat/ship",
		messageColor: "warning",
		canDelete: true,
		...overrides,
	};
}

describe("workflow resume engine plumbing (#5256)", () => {
	test("handles missing workflow run control and omitted optional picker hooks", async () => {
		const bare = await createHarness();
		harnesses.push(bare);

		assert.deepEqual(await listWorkflowResumeEntries(bare.session), []);
		assert.equal(await resumeWorkflowFromPicker(bare.session, "wf-123"), false);
		await assert.rejects(
			() => deleteWorkflowFromPicker(bare.session, "wf-123"),
			(error: unknown) =>
				error instanceof WorkflowRunControlUnavailableError &&
				error.code === "WORKFLOW_RUN_CONTROL_UNAVAILABLE" &&
				error.runId === "wf-123",
		);

		const partial = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerWorkflowRunControl({
						listRuns: async () => [],
						getRun: async () => {
							throw new Error("unused");
						},
						getStages: async () => [],
						pause: async () => ({ action: "pause", runId: "wf-1", status: "noop", message: "" }),
						quit: async () => ({ action: "quit", runId: "wf-1", status: "noop", message: "" }),
						resume: async () => ({ action: "resume", runId: "wf-1", status: "noop", message: "" }),
						waitForSettled: async () => {},
					});
				},
			],
		});
		harnesses.push(partial);

		assert.deepEqual(await listWorkflowResumeEntries(partial.session), []);
		assert.equal(await resumeWorkflowFromPicker(partial.session, "wf-123"), false);
		await assert.rejects(
			() => deleteWorkflowFromPicker(partial.session, "wf-123"),
			(error: unknown) => error instanceof WorkflowRunControlUnavailableError,
		);
	});

	test("invokes registered picker hooks with an ExtensionCommandContext and preserves row canDelete", async () => {
		const row = sampleRow();
		const listedTargets: Array<string | undefined> = [];
		const seenTargets: string[] = [];
		const deletedIds: string[] = [];
		let capturedContext: ExtensionCommandContext | undefined;

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerWorkflowRunControl({
						listRuns: async () => [],
						getRun: async () => {
							throw new Error("unused");
						},
						getStages: async () => [],
						pause: async () => ({ action: "pause", runId: "wf-1", status: "noop", message: "" }),
						quit: async () => ({ action: "quit", runId: "wf-1", status: "noop", message: "" }),
						resume: async () => ({ action: "resume", runId: "wf-1", status: "noop", message: "" }),
						waitForSettled: async () => {},
						listResumeEntries: async (target) => {
							listedTargets.push(target);
							return [row];
						},
						resumeFromPicker: async (target, ctx) => {
							seenTargets.push(target);
							capturedContext = ctx;
						},
						deleteResumeEntry: async (runId) => {
							if (runId === "Protected") throw new Error("Cannot delete an active workflow run");
							deletedIds.push(runId);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		const entries = await listWorkflowResumeEntries(harness.session);
		assert.deepEqual(entries, [row]);
		const targetedEntries = await listWorkflowResumeEntries(harness.session, "wf-cross-project");
		assert.deepEqual(targetedEntries, [row]);
		assert.deepEqual(listedTargets, [undefined, "wf-cross-project"]);
		assert.equal(sessionInfoFromPickerRow(row).canDelete, true);
		assert.equal(sessionInfoFromPickerRow(sampleRow({ canDelete: false })).canDelete, false);
		assert.equal(sessionInfoFromPickerRow(sampleRow({ canDelete: undefined })).canDelete, undefined);

		const handled = await resumeWorkflowFromPicker(harness.session, "wf-123");
		assert.equal(handled, true);
		assert.deepEqual(seenTargets, ["wf-123"]);
		assert.ok(capturedContext);
		assert.equal(typeof capturedContext.waitForIdle, "function");
		assert.equal(typeof capturedContext.newSession, "function");
		assert.equal(typeof capturedContext.switchSession, "function");
		assert.equal(typeof capturedContext.reload, "function");
		assert.equal(typeof capturedContext.ui.confirm, "function");

		await deleteWorkflowFromPicker(harness.session, "wf-123");
		assert.deepEqual(deletedIds, ["wf-123"]);
		await assert.rejects(
			() => deleteWorkflowFromPicker(harness.session, "Protected"),
			/Cannot delete an active workflow run/,
		);

		const parsed = parseInteractiveEngineMessage(
			JSON.stringify({
				type: "engine_session_picker_open",
				componentId: "picker-1",
				sessions: [row],
			}),
		);
		assert.ok(parsed && parsed.type === "engine_session_picker_open");
		assert.equal(parsed.sessions[0]?.canDelete, true);

		assert.equal(
			parseInteractiveEngineMessage(
				JSON.stringify({
					type: "engine_session_picker_open",
					componentId: "picker-1",
					sessions: [{ ...row, canDelete: "yes" }],
				}),
			),
			undefined,
		);

		const malformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerWorkflowRunControl({
						listRuns: async () => [],
						getRun: async () => {
							throw new Error("unused");
						},
						getStages: async () => [],
						pause: async () => ({ action: "pause", runId: "wf-1", status: "noop", message: "" }),
						quit: async () => ({ action: "quit", runId: "wf-1", status: "noop", message: "" }),
						resume: async () => ({ action: "resume", runId: "wf-1", status: "noop", message: "" }),
						waitForSettled: async () => {},
						listResumeEntries: async () =>
							[
								{
									...row,
									firstMessage: undefined as unknown as string,
								},
							] as readonly HostSessionPickerRow[],
					});
				},
			],
		});
		harnesses.push(malformedHarness);
		await assert.rejects(
			() => listWorkflowResumeEntries(malformedHarness.session),
			/Invalid workflow resume catalog/,
		);

		const nonFiniteHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerWorkflowRunControl({
						listRuns: async () => [],
						getRun: async () => {
							throw new Error("unused");
						},
						getStages: async () => [],
						pause: async () => ({ action: "pause", runId: "wf-1", status: "noop", message: "" }),
						quit: async () => ({ action: "quit", runId: "wf-1", status: "noop", message: "" }),
						resume: async () => ({ action: "resume", runId: "wf-1", status: "noop", message: "" }),
						waitForSettled: async () => {},
						listResumeEntries: async () => [{ ...row, createdAt: Number.NaN }],
					});
				},
			],
		});
		harnesses.push(nonFiniteHarness);
		await assert.rejects(
			() => listWorkflowResumeEntries(nonFiniteHarness.session),
			/Invalid workflow resume catalog/,
		);
	});
});
