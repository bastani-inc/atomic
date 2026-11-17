import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	formatWorkflowLifecycleNoticeText,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
	type WorkflowLifecycleNoticeKind,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";

import type { PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";

const kinds: readonly WorkflowLifecycleNoticeKind[] = [
	"started",
	"completed",
	"failed",
	"blocked",
	"budget_warning",
	"awaiting_input",
	"paused",
	"quit",
	"resumed",
];

for (const kind of kinds) {
	test(`workflow ${kind} notices point to the workflow browser (#5224)`, () => {
		const details: WorkflowLifecycleNoticeDetails = {
			kind,
			scope: "run",
			runId: "run-destination",
			workflowName: "release-check",
			status: kind === "completed" ? "completed" : kind === "failed" ? "failed" : "running",
			createdAt: 1,
			actor: "user",
		};
		const text = formatWorkflowLifecycleNoticeText(details);
		assert.doesNotMatch(text, /\/workflow\s/);
		if (kind !== "started" && kind !== "resumed") assert.match(text, /\/workflows run-destination/);
	});
}

test("workflow notices display source text without terminal commands (#5224)", () => {
	let renderer: PiMessageRenderer | undefined;
	registerLifecycleNoticeRenderer({
		rendererHost: {},
		registerMessageRenderer(_type, value) {
			renderer = value;
		},
	});
	const unsafe = "name\x1b[2J\x1b]52;c;Yg==\x07\nnext\r\u009b2J";
	const details: WorkflowLifecycleNoticeDetails = {
		kind: "failed",
		scope: "run",
		runId: unsafe,
		workflowName: unsafe,
		stageName: unsafe,
		error: unsafe,
		status: "failed",
		createdAt: 1,
	};
	const rendered = renderer?.({ details });
	assert.ok(rendered && typeof rendered === "object");
	for (const width of [24, 80, 160]) {
		const rows = rendered.render(width);
		const text = rows.join("\n");
		assert.doesNotMatch(text, /\x1b\[2J|\x1b\]52;|\x07|[\u0080-\u009f]/);
		assert.ok(rows.every((row) => !/[\r\n]/.test(row)));
	}
	assert.equal(details.workflowName, unsafe);
	assert.equal(details.error, unsafe);
});

test("workflow completion notices share the compact notice line in both expansion states (#5224)", () => {
	let renderer: PiMessageRenderer | undefined;
	registerLifecycleNoticeRenderer({
		rendererHost: {},
		registerMessageRenderer(_type, value) {
			renderer = value;
		},
	});
	const details: WorkflowLifecycleNoticeDetails = {
		kind: "completed",
		scope: "run",
		runId: "completed-run",
		workflowName: "release-check",
		status: "completed",
		durationMs: 4000,
		createdAt: 1,
	};
	const original = formatWorkflowLifecycleNoticeText(details);
	for (const expanded of [false, true]) {
		const rendered = renderer?.({ details }, { expanded });
		assert.ok(rendered && typeof rendered === "object");
		for (const width of [80, 160]) {
			const rows: string[] = rendered.render(width).map(stripTerminalSequences);
			assert.equal(rows[0]?.trim(), '● Workflow "release-check" completed · 4s');
			assert.doesNotMatch(rows.join("\n"), /[╭╮╰╯│]/);
			if (!expanded) assert.equal(rows.length, 1);
			else assert.match(rows.join("\n"), /completed-run/);
		}
	}
	assert.equal(formatWorkflowLifecycleNoticeText(details), original);
});
