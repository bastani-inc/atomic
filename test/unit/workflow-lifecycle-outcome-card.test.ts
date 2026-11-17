import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	createWorkflowLifecycleNotificationState,
	formatWorkflowLifecycleNoticeText,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

const STACK =
	"Error: verify gate failed: 2 jobs\n    at verifyStage (/repo/ralph.ts:41:11)\n    at run (/repo/x.js:1:1)";

function setup() {
	initTheme("dark");
	const store = createStore();
	const sent: Array<{ details?: WorkflowLifecycleNoticeDetails }> = [];
	installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed", "failed"] },
		state: createWorkflowLifecycleNotificationState(),
		sendMessage(message) {
			sent.push(message as { details?: WorkflowLifecycleNoticeDetails });
		},
	});
	let renderer: PiMessageRenderer | undefined;
	registerLifecycleNoticeRenderer({
		rendererHost: {},
		registerMessageRenderer(_event, r) {
			renderer = r;
		},
	});
	const card = (message: { details?: WorkflowLifecycleNoticeDetails }, width = 100) => {
		const component = renderer?.({ details: message.details }, { expanded: true });
		assert.ok(component && typeof component !== "string");
		return component.render(width).map((line) => stripAnsi(line));
	};
	return { store, sent, card };
}

function startRun(store: ReturnType<typeof createStore>, id: string, stages: StageSnapshot[] = []) {
	store.recordRunStart({ id, name: "ralph", inputs: {}, status: "running", toolNodes: [], stages, startedAt: 1 });
}

describe("workflow completion card: outputs and diagnostics (#5224)", () => {
	test("expanded workflow notices use the shared connector without a separate frame (#5224)", async () => {
		const { store, sent, card } = setup();
		startRun(store, "run-shared-notice");
		store.recordRunEnd("run-shared-notice", "completed", { summary: "ready" });
		await Promise.resolve();
		const notice = sent.find((message) => message.details?.kind === "completed");
		assert.ok(notice);
		const rows = card(notice);
		assert.match(rows[0]!, /● Workflow "ralph" completed/);
		const outputPad = rows[0]!.indexOf("●");
		assert.ok(rows[1]!.startsWith(`${" ".repeat(outputPad)}  ⎿  run `));
		assert.doesNotMatch(rows.join("\n"), /[╭╮╰╯│]/);
		assert.match(rows.join("\n"), /outputs\s+summary: ready/);
	});

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
					{ kind: "output", path: "/repo/out/summary.md" },
					{ kind: "output", path: "/repo/out/trace.json" },
				],
			},
		]);
		store.recordRunEnd("run-ok", "completed", { summary: "Fixed the benchmark", prNumber: 5236 });
		await Promise.resolve();
		const notice = sent.find((message) => message.details?.kind === "completed");
		assert.ok(notice, "a completion notice was sent");
		const text = card(notice).join("\n");
		assert.match(text, /outputs\s+summary: Fixed the benchmark · prNumber: 5236/);
		assert.match(text, /artifact\s+diff \/repo\/\.atomic\/impl\.patch · 3 files · \+40 −2/);
		assert.match(text, /\+1 more/);
		assert.match(text, /\/workflows run-ok, then o: run details/);
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
		assert.match(text, /reason\s+verify gate failed: 2 jobs/);
		assert.doesNotMatch(text, /at verifyStage/);
		assert.match(text, /full log: \/workflows run-bad, then o and l/);
		assert.ok(notice.details);
		assert.match(formatWorkflowLifecycleNoticeText(notice.details), /verify gate failed: 2 jobs/);
	});
	test("names, outputs and reasons on the card are inert, never live escape sequences (#5224)", async () => {
		const { store, sent } = setup();
		const evil = "a\x1b]52;c;aGk=\x07b\x1b[2Jc\u202ed";
		store.recordRunStart({
			id: "run-evil",
			name: `wf ${evil}`,
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordRunEnd("run-evil", "completed", { [`k${evil}`]: `v ${evil}` });
		await Promise.resolve();
		const notice = sent.find((message) => message.details?.kind === "completed");
		assert.ok(notice);
		let renderer: PiMessageRenderer | undefined;
		registerLifecycleNoticeRenderer({
			rendererHost: {},
			registerMessageRenderer(_event, r) {
				renderer = r;
			},
		});
		const component = renderer?.({ details: notice.details }, { expanded: true });
		assert.ok(component && typeof component !== "string");
		for (const width of [80, 160]) {
			for (const line of component.render(width)) {
				assert.doesNotMatch(line, /\x1b\]/);
				assert.doesNotMatch(line, /\x1b\[2J/);
				assert.doesNotMatch(line, /\u202e/);
			}
		}
	});
});
