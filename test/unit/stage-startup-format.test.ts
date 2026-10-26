import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { formatStageStartup, type StageStartupSnapshot } from "../../packages/workflows/src/shared/stage-startup.js";

const STARTED_AT = 1_000_000;

function startup(overrides: Partial<StageStartupSnapshot>): StageStartupSnapshot {
	return {
		phase: "first-dispatch",
		startedAt: STARTED_AT,
		phaseStartedAt: STARTED_AT + 2_100,
		state: "dispatched",
		ownershipPending: false,
		...overrides,
	};
}

describe("formatStageStartup", () => {
	test("a dispatched stage reports startup complete instead of a stuck first-dispatch step (#3967)", () => {
		const line = formatStageStartup(startup({}), STARTED_AT + 61_000);
		assert.equal(line, "startup complete (dispatched after 2s)");
		assert.doesNotMatch(line, /first-dispatch|current step/);
	});

	test("a dispatched stage line is stable while the stage keeps running (#3967)", () => {
		const snapshot = startup({ phaseStartedAt: STARTED_AT });
		assert.equal(formatStageStartup(snapshot, STARTED_AT + 16_000), "startup complete (dispatched after 0s)");
		assert.equal(formatStageStartup(snapshot, STARTED_AT + 226_000), "startup complete (dispatched after 0s)");
	});

	test("an active startup phase keeps reporting its current step", () => {
		const line = formatStageStartup(
			startup({ phase: "reload-active", state: "active", phaseStartedAt: STARTED_AT }),
			STARTED_AT + 45_000,
		);
		assert.equal(line, "startup reload-active (45s total, 45s on current step; active)");
	});

	test("a failed startup keeps reporting the phase it stopped in", () => {
		const line = formatStageStartup(
			startup({ phase: "sdk-creation", state: "failed", phaseStartedAt: STARTED_AT, settledAt: STARTED_AT + 9_000 }),
			STARTED_AT + 60_000,
		);
		assert.equal(line, "startup sdk-creation (9s total, 9s on current step; failed)");
	});
});

describe("workflow tool stage output", () => {
	test("stages and stage actions say startup is complete for a dispatched stage (#3967)", () => {
		const stage = {
			id: "three",
			name: "three",
			status: "running" as const,
			startup: startup({}),
		};
		const stages = renderWorkflowToolContent(
			{ action: "stages", runId: "run-1", filter: "all", stages: [stage] } as Parameters<
				typeof renderWorkflowToolContent
			>[0],
			{ action: "stages" },
		);
		assert.match(stages, /\[1\] three \(three\) running\nstartup complete \(dispatched after 2s\)/);
		assert.doesNotMatch(stages, /first-dispatch|current step/);
	});
});
