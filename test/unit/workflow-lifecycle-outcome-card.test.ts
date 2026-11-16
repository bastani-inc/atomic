// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, test } from "vitest";
import {
	createWorkflowLifecycleNotificationState,
	formatWorkflowLifecycleNoticeText,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

const STACK =
	"Error: verify gate failed: 2 jobs\n    at verifyStage (/repo/ralph.ts:41:11)\n    at run (/repo/x.js:1:1)";

function setup() {
	const store = createStore();
	const sent = [];
	installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed", "failed"] },
		state: createWorkflowLifecycleNotificationState(),
		sendMessage(message) {
			sent.push(message);
		},
	});
	let renderer: ((payload: unknown) => { render(width: number): string[] }) | undefined;
	registerLifecycleNoticeRenderer({
		rendererHost: {},
		registerMessageRenderer(_event, r) {
			renderer = r;
		},
	});
	const card = (message, width = 100) =>
		renderer!({ details: message.details })
			.render(width)
			.map((line) => stripAnsi(line));
	return { store, sent, card };
}

function startRun(store, id, stages = []) {
	store.recordRunStart({ id, name: "ralph", inputs: {}, status: "running", toolNodes: [], stages, startedAt: 1 });
}

describe("workflow completion card: outputs and diagnostics (#5224)", () => {
	test("a completed run's card shows its declared outputs and the artifacts its stages collected", async () => {
		const { store, sent, card } = setup();
		startRun(store, "run-ok", [
			{
				id: "s1",
				name: "implement",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				artifacts: [
					{ kind: "diff", path: "/repo/.atomic/impl.patch", filesChanged: 3, insertions: 40, deletions: 2 },
					{ kind: "output", path: "/repo/out/report.md" },
				],
			},
		]);
		store.recordRunEnd("run-ok", "completed", { summary: "Fixed the benchmark", prNumber: 5236 });
		await Promise.resolve();
		const notice = sent.find((message) => message.details?.kind === "completed");
		assert.ok(notice, "a completion notice was sent");
		const text = card(notice).join("\n");
		assert.match(text, /outputs\s+summary: Fixed the benchmark · prNumber: 5236/);
		assert.match(text, /artifacts\s+diff \/repo\/\.atomic\/impl\.patch · 3 files · \+40 −2/);
		assert.match(text, /\+1 more/);
		assert.match(text, /\/workflows, then o: run details/);
		for (const line of card(notice, 80)) assert.ok(visibleWidth(line) <= 80, line);
	});

	test("a failed run's card shows the short reason, never a stack frame", async () => {
		const { store, sent, card } = setup();
		startRun(store, "run-bad", [
			{ id: "verify", name: "verify", status: "failed", parentIds: [], toolEvents: [], error: STACK },
		]);
		store.recordRunEnd("run-bad", "failed", undefined, STACK, { failedStageId: "verify" });
		await Promise.resolve();
		const notice = sent.find((message) => message.details?.kind === "failed");
		assert.ok(notice);
		const text = card(notice).join("\n");
		assert.match(text, /error\s+verify gate failed: 2 jobs/);
		assert.doesNotMatch(text, /at verifyStage/);
		assert.match(text, /full log: \/workflows, then o and l/);
		// What the model reads keeps the full error: only the card shortens it.
		assert.match(formatWorkflowLifecycleNoticeText(notice.details), /verify gate failed: 2 jobs/);
	});
});
