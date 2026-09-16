import assert from "node:assert/strict";
import { test } from "vitest";
import {
	resolveRunIndicatorStatuses,
	runIndicatorStatus,
} from "../../packages/workflows/src/shared/run-indicator-status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { pendingInputAffordance } from "../../packages/workflows/src/tui/pending-input-affordance.js";
import { createSessionPickerState, renderSessionPicker } from "../../packages/workflows/src/tui/session-picker.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { buildThemedWidgetLines } from "../../packages/workflows/src/tui/widget.js";

function makeUnownedWait(): { root: RunSnapshot; child: RunSnapshot } {
	const root: RunSnapshot = {
		id: "11111111-1111-4111-8111-111111111111",
		name: "visible-root",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
	};
	const child: RunSnapshot = {
		...root,
		id: "22222222-2222-4222-8222-222222222222",
		name: "hidden-child",
		parentRunId: root.id,
		rootRunId: root.id,
		pendingPrompt: { id: "synthetic-prompt", kind: "input", message: "Synthetic unowned question?", createdAt: 2 },
	};
	return { root, child };
}

// PR #2700: status-only traversal is deliberately non-reciprocal: listings, restored
// `/workflow status` payloads and the picker lack a proven ownership chain, so
// they accept rootRunId/parentRunId claims. The widget requires reciprocal
// boundaries and live ancestry, and fails closed on a one-sided claimant.
test("status-only surfaces show a one-sided claimant's wait while the widget indicator and affordance fail closed", () => {
	const { root, child } = makeUnownedWait();
	const runs = [root, child];
	const before = structuredClone(runs);
	const status = renderStatusList([root], { width: 100, now: 10, allRuns: runs, showDetailHint: false });
	const identityLine = status.split("\n").find((line) => line.includes(root.id));
	assert.ok(identityLine?.includes(statusIcon("awaiting_input")), status);

	const restored: ReturnType<typeof resolveRunIndicatorStatuses> = JSON.parse(
		JSON.stringify(resolveRunIndicatorStatuses([root], runs)),
	);
	assert.deepEqual(restored, { [root.id]: "awaiting_input" });
	const restoredStatus = renderStatusList([root], {
		width: 100,
		now: 10,
		indicatorStatuses: restored,
		showDetailHint: false,
	});
	assert.equal(restoredStatus, status);
	const picker = renderSessionPicker({
		width: 100,
		theme: deriveGraphTheme({}),
		rows: [{ run: root, bucket: "active" }],
		state: createSessionPickerState(),
		allRuns: runs,
		now: 10,
	});
	assert.ok(picker.find((line) => line.includes(root.id))?.includes(statusIcon("awaiting_input")));

	const widget = buildThemedWidgetLines({ runs, notices: [], version: 1 }, undefined, 100, 10).join("\n");
	assert.equal(runIndicatorStatus(root, runs), "running");
	assert.equal(pendingInputAffordance(root, runs), undefined);
	assert.doesNotMatch(widget, /Synthetic unowned question|F2 answer|\/workflow connect/);
	assert.deepEqual(runs, before);
});

// PR #2700: a completed parent boundary revokes widget ownership (reciprocal + live
// ancestry) but not status-only attribution (rootRunId/parentRunId claims).
test("a completed parent boundary revokes widget ownership but not status-only attribution", () => {
	const { root, child } = makeUnownedWait();
	root.stages.push({
		id: "child-boundary",
		name: "child",
		status: "running",
		parentIds: [],
		toolEvents: [],
		workflowChildRun: { alias: "child", workflow: child.name, runId: child.id },
	});
	child.parentStageId = "child-boundary";
	const runs = [root, child];
	for (const boundaryStatus of ["running", "completed"] as const) {
		root.stages[0]!.status = boundaryStatus;
		const status = renderStatusList([root], { width: 100, now: 10, allRuns: runs, showDetailHint: false });
		assert.ok(
			status
				.split("\n")
				.find((line) => line.includes(root.id))
				?.includes(statusIcon("awaiting_input")),
		);
		const widget = buildThemedWidgetLines({ runs, notices: [], version: 1 }, undefined, 100, 10).join("\n");
		if (boundaryStatus === "running") {
			assert.equal(runIndicatorStatus(root, runs), "awaiting_input");
			assert.deepEqual(pendingInputAffordance(root, runs)?.identity, [child.id, null, "synthetic-prompt"]);
			assert.match(widget, /Synthetic unowned question/);
			assert.ok(widget.includes(`/workflow connect ${root.id}`));
		} else {
			assert.equal(runIndicatorStatus(root, runs), "running");
			assert.equal(pendingInputAffordance(root, runs), undefined);
			assert.doesNotMatch(widget, /Synthetic unowned question|F2 answer|\/workflow connect/);
		}
	}
});
