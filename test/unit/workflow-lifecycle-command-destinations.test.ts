import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	formatWorkflowLifecycleNoticeText,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
	type WorkflowLifecycleNoticeKind,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";

import type { PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowArtifact } from "../../packages/workflows/src/shared/types.js";

beforeAll(() => initTheme("dark"));

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

test("workflow completion artifact previews inspect only their bounded prefix (#5224)", () => {
	let inspected = 0;
	const artifacts = new Proxy(new Array<WorkflowArtifact>(1000), {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				inspected++;
				assert.ok(inspected <= 3, "a sparse artifact list must not extend preview inspection");
			}
			return Reflect.get(target, property, receiver);
		},
	});
	artifacts[0] = { kind: "diff", path: "unavailable.diff", captureError: "offline\n    at capture (git.ts:1:2)" };
	artifacts[1] = { kind: "output", path: "report.md" };
	const run: RunSnapshot = {
		id: "artifact-run",
		name: "artifact-run",
		inputs: {},
		status: "completed",
		startedAt: 1,
		endedAt: 1001,
		durationMs: 1000,
		toolNodes: [],
		stages: [{ id: "stage", name: "stage", status: "completed", parentIds: [], toolEvents: [], artifacts }],
	};
	const store = {
		...createStore(),
		graphSnapshot: () => ({ runs: [run], notices: [], version: 1 }),
	};
	const delivered: WorkflowLifecycleNoticeDetails[] = [];
	let dispose: (() => void) | undefined;
	assert.doesNotThrow(() => {
		dispose = installWorkflowLifecycleNotifications({
			store,
			seedExisting: false,
			config: { enabled: true, notifyOn: ["completed"] },
			sendMessage(message) {
				delivered.push(message.details as WorkflowLifecycleNoticeDetails);
			},
		});
	});
	try {
		assert.equal(inspected, 3);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]?.artifacts?.total, artifacts.length);
		assert.deepEqual(delivered[0]?.artifacts?.shown, [
			{ kind: "diff", path: "unavailable.diff", detail: "not captured: offline" },
			{ kind: "output", path: "report.md" },
		]);
	} finally {
		dispose?.();
	}
});
