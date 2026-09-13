import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunStatus, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installStoreWidget, scrollStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { buildThemedWidgetLines, type WorkflowWidgetRowLayout } from "../../packages/workflows/src/tui/widget.js";
import { WorkflowWidgetViewport } from "../../packages/workflows/src/tui/widget-viewport.js";
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
		{ id: uuid(101), name: "duplicate name", status: "paused", startedAt: now, inputs: {}, stages: [] },
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
