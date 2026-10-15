import assert from "node:assert/strict";
import { Container, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunStatus, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installStoreWidget, scrollStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { buildThemedWidgetLines, type WorkflowWidgetRowLayout } from "../../packages/workflows/src/tui/widget.js";
import { WorkflowWidgetViewport } from "../../packages/workflows/src/tui/widget-viewport.js";
import { sleep } from "../helpers/runtime.js";
import { nativeWorkflowViewport } from "../helpers/workflow-native-viewport.js";

const now = Date.now();
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
function fixture() {
	const store = createStore();
	const add = (i: number) =>
		store.recordRunStart({
			id: uuid(i),
			name: "duplicate name",
			status: "paused",
			startedAt: now + i,
			inputs: {},
			toolNodes: [],
			stages: [],
		});
	for (let i = 0; i < 15; i++) add(i);
	let component: { render(width: number): string[] } | undefined;
	const host = { terminal: { rows: 30 }, requestRender() {} };
	const dispose = installStoreWidget(
		{
			ui: {
				setWidget(_key, factory) {
					if (factory)
						component = nativeWorkflowViewport(factory(host, undefined), () =>
							Math.max(1, Math.min(10, Math.floor(host.terminal.rows / 3))),
						);
				},
				requestRender() {},
			},
		},
		store,
	);
	const render = (width = 120) => {
		assert.ok(component);
		return component.render(width);
	};
	const scroll = (direction: -1 | 1, count = 1) => {
		for (let i = 0; i < count; i++) {
			scrollStoreWidget(store, direction);
			render();
		}
	};
	return { store, add, host, dispose, render, scroll };
}

// #3017 / Greptile3997857407: exercise the mounted production renderer, not fabricated labels.
test("scrolled workflow UUID survives insertion and removal above duplicate names", async () => {
	const f = fixture();
	try {
		f.render();
		f.scroll(1, 7);
		const before = f.render();
		assert.ok(before[0]?.includes(uuid(12)));
		f.add(99);
		await Promise.resolve();
		assert.equal(f.render()[0], before[0]);
		f.store.removeRun(uuid(14));
		await Promise.resolve();
		assert.equal(f.render()[0], before[0]);
	} finally {
		f.dispose();
	}
});

function rendererFixture() {
	const snapshot = {
		version: 0,
		notices: [],
		runs: Array.from({ length: 15 }, (_, i) => ({
			id: uuid(i),
			name: "duplicate name",
			status: "paused" as RunStatus,
			startedAt: now + i,
			inputs: {},
			toolNodes: [],
			stages: [],
		})),
	} satisfies StoreSnapshot;
	let clock = now + 10000;
	let rows = 30;
	const layout: WorkflowWidgetRowLayout = { runs: [] };
	const viewport = new WorkflowWidgetViewport(
		{ render: (width) => buildThemedWidgetLines(snapshot, undefined, width, clock, layout) },
		() => rows,
		() => {},
		() => layout.runs,
	);
	const native = nativeWorkflowViewport(viewport, () => Math.max(1, Math.min(10, Math.floor(rows / 3))));
	const render = (width = 120) => native.render(width);
	const scroll = (count: number) => {
		for (let i = 0; i < count; i++) {
			viewport.scroll(1);
			render();
		}
	};
	render();
	return {
		snapshot,
		viewport,
		render,
		scroll,
		tick: () => {
			clock += 65000;
		},
		resize: (height: number) => {
			rows = height;
		},
	};
}

// #3017: live text changes must not become identity changes.
test("live names, status and elapsed time preserve the selected workflow and its detail row", () => {
	const f = rendererFixture();
	f.scroll(8);
	const before = f.render()[0];
	f.snapshot.runs[12]!.name = " changed 界 duplicate name ";
	f.snapshot.runs[12]!.status = "running";
	f.tick();
	const after = f.render()[0];
	assert.notEqual(after, before);
	assert.ok(after?.includes(" changed 界 duplicate name "));
	assert.ok(after?.includes("1m"));
	f.viewport.scroll(-1);
	assert.ok(f.render()[0]?.includes(uuid(12)));
});

// #3017: deletion follows old reading order, never a duplicate display name.
test("deleted workflow falls forward, then backward, then resets when none survive", () => {
	const f = rendererFixture();
	f.resize(3);
	f.scroll(7);
	f.snapshot.runs = f.snapshot.runs.filter((run) => run.id !== uuid(12));
	assert.ok(f.render()[0]?.includes(uuid(11)));
	f.snapshot.runs = f.snapshot.runs.filter((run) => [uuid(13), uuid(14)].includes(run.id));
	assert.ok(f.render()[0]?.includes(uuid(13)));
	f.snapshot.runs = [{ ...f.snapshot.runs[0]!, id: uuid(99) }];
	assert.ok(f.render()[0]?.startsWith("╭"));
	f.resize(30);
	assert.ok(f.render().join("\n").includes(uuid(99)));
	f.snapshot.runs = [];
	assert.deepEqual(f.render(), []);
});

// #3017: collapsed chrome must not discard the reader's expanded-list position.
test("resize and collapsed live updates restore the workflow anchor without moving the top", () => {
	const f = rendererFixture();
	f.scroll(7);
	for (const height of [9, 3, 30, 60]) {
		f.resize(height);
		assert.ok(f.render(80)[0]?.includes(uuid(12)));
	}
	assert.equal(f.render(27).length, 1);
	f.viewport.scroll(1);
	f.snapshot.runs.unshift({ ...f.snapshot.runs[0]!, id: uuid(99), startedAt: now + 99 });
	assert.equal(f.render(1).length, 1);
	assert.ok(f.render(120)[0]?.includes(uuid(12)));
	for (let i = 0; i < 100; i++) {
		f.viewport.scroll(-1);
		f.render();
	}
	assert.ok(f.render()[0]?.startsWith("╭"));
	f.snapshot.runs.unshift({ ...f.snapshot.runs[0]!, id: uuid(100), startedAt: now + 100 });
	assert.ok(f.render()[0]?.startsWith("╭"));
	assert.ok(f.render()[1]?.includes(uuid(100)));
	f.render(27);
	f.snapshot.runs = [];
	assert.deepEqual(f.render(27), []);
	f.snapshot.runs = [
		{
			id: uuid(101),
			name: "duplicate name",
			status: "paused",
			startedAt: now,
			inputs: {},
			toolNodes: [],
			stages: [],
		},
	];
	assert.ok(f.render()[0]?.startsWith("╭"));
	assert.ok(f.render()[1]?.includes(uuid(101)));
});

// #3017: opt-in identity metadata must leave rendered text and order untouched.
test("row boundaries preserve raw duplicate names and make every actual source row reachable", () => {
	const f = rendererFixture();
	f.snapshot.runs[0]!.name = " \u001b[31m界 same\u001b[0m ";
	f.snapshot.runs[1]!.name = f.snapshot.runs[0]!.name;
	for (const theme of [undefined, { fg: (_: string, text: string) => text, bold: (text: string) => text }]) {
		const layout: WorkflowWidgetRowLayout = { runs: [] };
		const raw = buildThemedWidgetLines(f.snapshot, theme, 120, now);
		assert.deepEqual(buildThemedWidgetLines(f.snapshot, theme, 120, now, layout), raw);
		assert.equal(new Set(layout.runs.map((run) => run.id)).size, 15);
		assert.deepEqual(
			layout.runs.map((run) => run.id),
			f.snapshot.runs.map((run) => run.id).reverse(),
		);
		const viewport = new WorkflowWidgetViewport(
			{ render: (width) => buildThemedWidgetLines(f.snapshot, theme, width, now, layout) },
			() => 9,
			() => {},
			() => layout.runs,
		);
		const native = nativeWorkflowViewport(viewport, () => 1);
		for (const row of raw) {
			assert.equal(native.render(120)[0], row);
			viewport.scroll(1);
		}
		assert.equal(native.render(120)[0], raw.at(-1));
	}
});

// #3017: a separator leads into the next workflow, not the one above the viewport.
test("insertion directly after the offscreen workflow preserves the first visible UUID", () => {
	const f = rendererFixture();
	f.scroll(6);
	const firstId = () =>
		f
			.render()
			.join("\n")
			.match(/00000000-0000-4000-8000-\d{12}/)?.[0];
	assert.equal(firstId(), uuid(12));
	f.snapshot.runs.push({ ...f.snapshot.runs[0]!, id: uuid(99), startedAt: now + 12.5 });
	assert.equal(firstId(), uuid(12));
});

// #3017: the bottom border is part of the final run until another older run appears.
test("a shortened run boundary clamps the row offset without selecting the newly appended run", () => {
	const f = rendererFixture();
	f.resize(3);
	f.scroll(100);
	assert.ok(f.render()[0]?.startsWith("╰"));
	f.snapshot.runs.push({ ...f.snapshot.runs[0]!, id: uuid(99), startedAt: now - 1 });
	assert.ok(f.render()[0]?.includes("duplicate name"));
	f.viewport.scroll(-1);
	assert.ok(f.render()[0]?.includes(uuid(0)));
});

test("prompt row insertion and removal preserve the scrolled workflow anchor", () => {
	const f = rendererFixture();
	f.scroll(8);
	const visibleId = f
		.render()
		.join("\n")
		.match(/00000000-0000-4000-8000-\d{12}/)?.[0];
	assert.ok(visibleId);
	const run = f.snapshot.runs.find((candidate) => candidate.id === visibleId)!;
	run.status = "running";
	const stages = run.stages as StageSnapshot[];
	stages.length = 0;
	stages.push({
		id: "ask",
		name: "ask",
		status: "awaiting_input",
		parentIds: [],
		toolEvents: [],
		pendingPrompt: { id: "prompt-12", kind: "confirm", message: "Approve insertion?", createdAt: now },
	});
	assert.ok(f.render().some((line) => line.includes(visibleId)));
	assert.ok(f.render().some((line) => line.includes("Approve insertion?")));
	stages.length = 0;
	assert.ok(f.render().some((line) => line.includes(visibleId)));
	assert.ok(!f.render().some((line) => line.includes("Approve insertion?")));
});

test("every prompt and navigation row remains reachable in a one-row viewport", () => {
	const snapshot = {
		version: 0,
		notices: [],
		runs: [
			{
				id: uuid(1),
				name: "waiting",
				status: "running" as RunStatus,
				startedAt: now,
				inputs: {},
				toolNodes: [],
				stages: [
					{
						id: "ask",
						name: "ask",
						status: "awaiting_input" as const,
						parentIds: [],
						toolEvents: [],
						pendingPrompt: {
							id: "prompt-1",
							kind: "confirm" as const,
							message: "Approve the one-row prompt?",
							createdAt: now,
						},
					},
				],
			},
		],
	} satisfies StoreSnapshot;
	const layout: WorkflowWidgetRowLayout = { runs: [] };
	const raw = buildThemedWidgetLines(snapshot, undefined, 120, now, layout);
	assert.ok(raw.some((line) => line.includes("Approve the one-row prompt?")));
	assert.ok(raw.some((line) => line.includes(`/workflow connect ${uuid(1)}`)));
	assert.ok(layout.runs[0]);
	assert.ok(layout.runs[0]!.end > layout.runs[0]!.start);
	const viewport = new WorkflowWidgetViewport(
		{ render: (width) => buildThemedWidgetLines(snapshot, undefined, width, now, layout) },
		() => 9,
		() => {},
		() => layout.runs,
	);
	const native = nativeWorkflowViewport(viewport, () => 1);
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		seen.add(native.render(120)[0] ?? "");
		viewport.scroll(1);
	}
	assert.ok([...seen].some((line) => line.includes("Approve the one-row prompt?")));
	assert.ok([...seen].some((line) => line.includes(`/workflow connect ${uuid(1)}`)));
});

test("multi-root prompt and connect pairs stay inside their owning layout ranges", () => {
	const subsets: Array<{ awaiting: readonly number[]; rows: number }> = [
		{ awaiting: [], rows: 10 },
		{ awaiting: [1], rows: 12 },
		{ awaiting: [2], rows: 12 },
		{ awaiting: [1, 3], rows: 14 },
		{ awaiting: [1, 2, 3], rows: 16 },
	];
	for (const { awaiting, rows } of subsets) {
		const waiting = new Set(awaiting);
		const snapshot = {
			version: 0,
			notices: [],
			runs: [1, 2, 3].map((index) => ({
				id: uuid(index),
				name: `root-${index}`,
				status: "running" as RunStatus,
				startedAt: now + index,
				inputs: {},
				toolNodes: [],
				stages: waiting.has(index)
					? [
							{
								id: "ask",
								name: "ask",
								status: "awaiting_input" as const,
								parentIds: [],
								toolEvents: [],
								pendingPrompt: {
									id: `prompt-${index}`,
									kind: "confirm" as const,
									message: `Approve root ${index}?`,
									createdAt: now,
								},
							},
						]
					: [],
			})),
		} satisfies StoreSnapshot;
		const layout: WorkflowWidgetRowLayout = { runs: [] };
		const lines = buildThemedWidgetLines(snapshot, undefined, 120, now, layout);
		assert.equal(lines.length, rows, `awaiting ${awaiting.join(",") || "none"}`);
		assert.equal(layout.runs.length, 3);
		assert.deepEqual(
			layout.runs.map((run) => run.id),
			[uuid(3), uuid(2), uuid(1)],
		);
		for (let i = 1; i < layout.runs.length; i++) {
			assert.ok(layout.runs[i]!.start > layout.runs[i - 1]!.start);
			assert.ok(layout.runs[i]!.start >= layout.runs[i - 1]!.end);
		}

		const answerOwners = new Map<number, string>();
		for (const range of layout.runs) {
			const card = lines.slice(range.start, range.end);
			const index = Number(range.id.slice(-1));
			const prompt = `Approve root ${index}?`;
			const connect = `Answer: /workflow connect ${range.id}`;
			assert.equal(
				card.some((line) => line.includes(range.id)),
				true,
				range.id,
			);
			const actionRows = card.filter(
				(line) => line.includes(`"${prompt}"`) || line.includes("Answer: /workflow connect"),
			);
			if (waiting.has(index)) {
				assert.equal(actionRows.length, 2, range.id);
				assert.equal(
					card.some((line) => line.includes(`"${prompt}"`)),
					true,
					range.id,
				);
				assert.equal(
					card.some((line) => line.includes(connect)),
					true,
					range.id,
				);
			} else {
				assert.equal(actionRows.length, 0, range.id);
				assert.equal(
					card.some((line) => line.includes('"')),
					false,
					range.id,
				);
				assert.equal(
					card.some((line) => line.includes("Answer: /workflow connect")),
					false,
					range.id,
				);
			}
			for (const [lineIndex, line] of card.entries()) {
				if (!line.includes("Answer: /workflow connect")) continue;
				const absolute = range.start + lineIndex;
				assert.equal(answerOwners.has(absolute), false, `answer row ${absolute} reused`);
				answerOwners.set(absolute, range.id);
			}
		}
		assert.equal(answerOwners.size, awaiting.length);
		for (const [absolute, ownerId] of answerOwners) {
			const owners = layout.runs.filter((range) => absolute >= range.start && absolute < range.end);
			assert.deepEqual(
				owners.map((range) => range.id),
				[ownerId],
			);
		}
	}
});

test("below-editor pending input growth stays a differential redraw", async () => {
	const NOW = Date.now();
	const runId = "00000000-0000-4000-8000-000000000042";
	// These clears are the #1109 screen+scrollback wipe.
	const SCREEN_CLEAR = "\u001b[2J";
	const SCROLLBACK_CLEAR = "\u001b[3J";
	const geometries: Array<[rows: number, footerRows: number, historyRows: number]> = [
		[24, 8, 60],
		[26, 20, 60],
		[40, 4, 10],
		[9, 2, 60],
	];

	for (const [rows, footerRows, historyRows] of geometries) {
		const store = createStore();
		store.recordRunStart({
			id: runId,
			name: "release-docs",
			inputs: {},
			status: "running",
			startedAt: NOW - 5_000,
			toolNodes: [],
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		const snapshot = () => ({ runs: store.runs(), notices: [] as const, version: 0 });
		const widgetLines = () => buildThemedWidgetLines(snapshot(), undefined, 110, NOW);
		const terminal = new RecordingTerminal();
		terminal.columns = 110;
		terminal.rows = rows;
		const tui = new TuiMainScreen(terminal, false, "/tmp");
		try {
			const chat = new Container();
			for (let index = 0; index < historyRows; index += 1) {
				chat.addChild(new Text(`history ${index}`, 0, 0));
			}
			tui.addChild(chat);
			const footer = new Container();
			for (let index = 0; index < footerRows; index += 1) {
				footer.addChild(new Text(`footer ${index}`, 0, 0));
			}
			footer.addChild({
				render: (width: number) => buildThemedWidgetLines(snapshot(), undefined, width, NOW),
				invalidate() {},
			});
			tui.addChild(footer);
			tui.requestRender();
			await sleep(50);
			assert.equal(widgetLines().length, 4, `${rows}/${footerRows}/${historyRows} idle height`);

			terminal.writes.length = 0;
			assert.equal(
				store.recordStagePendingPrompt(runId, "ask", {
					id: "p1",
					kind: "confirm",
					message: "Approve the generated migration before deployment?",
					createdAt: NOW,
				}),
				true,
			);
			tui.requestRender();
			await sleep(60);
			assert.equal(widgetLines().length, 6, `${rows}/${footerRows}/${historyRows} waiting height`);
			assert.equal(
				terminal.writes.filter((data) => data.includes(SCREEN_CLEAR)).length,
				0,
				`${rows}/${footerRows}/${historyRows} prompt appear screen clears`,
			);
			assert.equal(
				terminal.writes.filter((data) => data.includes(SCROLLBACK_CLEAR)).length,
				0,
				`${rows}/${footerRows}/${historyRows} prompt appear scrollback clears`,
			);
			assert.equal(terminal.writes.length, 1, `${rows}/${footerRows}/${historyRows} prompt appear writes`);

			terminal.writes.length = 0;
			assert.equal(store.resolveStagePendingPrompt(runId, "ask", "p1", true), true);
			tui.requestRender();
			await sleep(60);
			assert.equal(widgetLines().length, 4, `${rows}/${footerRows}/${historyRows} resolved height`);
			assert.equal(
				terminal.writes.filter((data) => data.includes(SCREEN_CLEAR)).length,
				0,
				`${rows}/${footerRows}/${historyRows} answer screen clears`,
			);
			assert.equal(
				terminal.writes.filter((data) => data.includes(SCROLLBACK_CLEAR)).length,
				0,
				`${rows}/${footerRows}/${historyRows} answer scrollback clears`,
			);
			assert.equal(terminal.writes.length, 1, `${rows}/${footerRows}/${historyRows} answer writes`);
		} finally {
			tui.stop();
		}
	}
});
