import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, test } from "vitest";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { WorkflowArtifact } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowOutputValues } from "../../packages/workflows/src/shared/types.js";

const NOTICE_SNIPPET_LIMIT = 240;

interface SentNotice {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details?: WorkflowLifecycleNoticeDetails;
}

function createHarness() {
	const store = createStore();
	const sent: SentNotice[] = [];
	installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed", "failed", "blocked"] },
		state: createWorkflowLifecycleNotificationState(),
		sendMessage(message) {
			sent.push(message as SentNotice);
		},
	});
	let renderer:
		| ((payload: {
				details?: WorkflowLifecycleNoticeDetails;
		  }) => { render(width: number): string[]; invalidate(): void } | undefined)
		| undefined;
	registerLifecycleNoticeRenderer({
		rendererHost: {},
		registerMessageRenderer(_event, registered) {
			renderer = registered as typeof renderer;
		},
	});
	return {
		store,
		sent,
		componentFor(details: WorkflowLifecycleNoticeDetails) {
			const component = renderer?.({ details });
			assert.ok(component);
			return component;
		},
	};
}

describe("workflow lifecycle notice bounds and caching (#5224)", () => {
	test("caps a failed or blocked run's first error line at 240 chars and reuses the wrapped card across frame renders (#5224)", async () => {
		const { store, sent, componentFor } = createHarness();
		const unit = '{"id":12345,"name":"service item name","tags":["alpha","beta"],"ok":false},';
		const largeBody = unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000);
		const longSingleLineError = `Error: upstream returned 502: ${largeBody}`;

		store.recordRunStart({
			id: "run-long-fail",
			name: "verify-gate",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [{ id: "impl", name: "impl", status: "running", parentIds: [], toolEvents: [], startedAt: 1 }],
			startedAt: 1,
		});
		store.recordRunEnd("run-long-fail", "failed", undefined, longSingleLineError);
		await Promise.resolve();

		const notice = sent.find((entry) => entry.details?.kind === "failed");
		assert.ok(notice?.details);
		assert.equal(notice.details.reason?.length, NOTICE_SNIPPET_LIMIT);
		assert.ok(notice.details.reason?.endsWith("…"));
		assert.ok(JSON.stringify(notice.details).length < 1024);

		store.recordRunStart({
			id: "run-medium-fail",
			name: "verify-gate",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 2,
		});
		store.recordRunEnd("run-medium-fail", "failed", undefined, `Error: ${"x".repeat(400)}`);
		await Promise.resolve();

		const mediumNotice = sent.find((entry) => entry.details?.runId === "run-medium-fail");
		assert.ok(mediumNotice?.details);
		assert.equal(mediumNotice.details.reason?.length, NOTICE_SNIPPET_LIMIT);
		assert.ok(mediumNotice.details.reason?.endsWith("…"));

		const component = componentFor(notice.details);
		const firstRender = component.render(100);
		const secondRender = component.render(100);
		assert.equal(firstRender.length <= 16, true);
		assert.equal(secondRender, firstRender);

		const narrowRender = component.render(80);
		assert.notEqual(narrowRender, firstRender);
		assert.equal(component.render(80), narrowRender);

		component.invalidate();
		const afterInvalidate = component.render(80);
		assert.notEqual(afterInvalidate, narrowRender);
		assert.deepEqual(afterInvalidate, narrowRender);
	});

	test("formats completed run outputs once and summarizes artifacts without inspecting unshown stage artifacts (#5224)", async () => {
		const { store, sent, componentFor } = createHarness();
		let outputSerializeCalls = 0;
		let unshownArtifactReads = 0;

		const shownArtifact: WorkflowArtifact = {
			kind: "diff",
			path: "/repo/.atomic/first.patch",
			filesChanged: 2,
			insertions: 10,
			deletions: 3,
		};
		const unshownArtifacts: WorkflowArtifact[] = Array.from({ length: 9_999 }, (_, index) => {
			const item = { kind: "output" as const, path: `/repo/out/${index}.md` };
			Object.defineProperty(item, "captureError", {
				enumerable: true,
				get() {
					unshownArtifactReads += 1;
					return undefined;
				},
			});
			return item;
		});

		store.recordRunStart({
			id: "run-once",
			name: "ship-notes",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [
				{
					id: "s1",
					name: "collect",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					artifacts: [shownArtifact, ...unshownArtifacts],
					startedAt: 1,
					endedAt: 2,
				},
			],
			startedAt: 1,
		});

		const fullOutputs = {
			payload: {
				toJSON() {
					outputSerializeCalls += 1;
					return { ok: true };
				},
			},
			blob: "x".repeat(5_000_000),
		} as unknown as WorkflowOutputValues;
		unshownArtifactReads = 0;
		store.recordRunEnd("run-once", "completed", fullOutputs);
		await Promise.resolve();

		const notice = sent.find((entry) => entry.details?.kind === "completed");
		assert.ok(notice?.details);
		assert.equal(outputSerializeCalls, 1);
		assert.equal(unshownArtifactReads, 0);
		assert.equal(notice.details.artifacts?.total, 10_000);
		assert.equal(notice.details.artifacts?.shown.length, 1);
		assert.equal(notice.details.outputsPreview?.length, NOTICE_SNIPPET_LIMIT);

		const cardText = componentFor(notice.details)
			.render(100)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(cardText, /artifacts\s+diff \/repo\/\.atomic\/first\.patch · 2 files · \+10 −3 · \+9999 more/);
	});

	test("normalizes a CRLF workflow name before rendering the single-line notice headline (#5224)", async () => {
		const { store, sent, componentFor } = createHarness();
		store.recordRunStart({
			id: "run-crlf",
			name: "release\r\nnotes",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordRunEnd("run-crlf", "completed", { summary: "ok" });
		await Promise.resolve();

		const notice = sent.find((entry) => entry.details?.kind === "completed");
		assert.ok(notice?.details);
		assert.doesNotMatch(notice.content, /\\x0d|\r|\n/);
		assert.match(notice.content, /Workflow "release notes" completed/);

		const rows = componentFor(notice.details)
			.render(100)
			.map((line) => stripAnsi(line));
		const headlineRow = rows.find((line) => line.includes("completed"));
		assert.ok(headlineRow);
		assert.match(headlineRow, /✓ Workflow "release notes" completed/);
		for (const row of rows) {
			assert.doesNotMatch(row, /\\x0d/);
		}
	});
});
