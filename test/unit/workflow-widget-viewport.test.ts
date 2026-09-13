import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { buildThemedWidgetLines } from "../../packages/workflows/src/tui/widget.js";

const now = 1_700_000_000_000;
const snap: StoreSnapshot = {
	runs: ["running", "paused", "blocked"].map((status, i) => ({
		id: `run-${i}`,
		name: "\x1b[31m界🧪 long workflow name\x1b[0m".repeat(8),
		status: status as "running" | "paused" | "blocked",
		inputs: {},
		stages: [],
		startedAt: now,
		toolNodes: [
			{
				kind: "tool" as const,
				id: `tool-${i}`,
				name: "界 tool ".repeat(30),
				argsHash: "fixture",
				ordinal: 0,
				parentIds: [],
				status: "running" as const,
				attachable: false as const,
			},
		],
	})),
	notices: [],
	version: 1,
};

// #3015: collapsed status combinations must obey the actual terminal width.
test("workflow lines remain width-safe through seeded narrow/wide resize transitions", () => {
	let seed = 3015;
	const widths = [27, 120, 26, 28, 79, 80, 81, 1, 0];
	for (let i = 0; i < 100; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		widths.push((i % 2 ? 80 : 27) + (seed % 11) - 5);
	}
	const combinations: StoreSnapshot[] = [
		snap,
		{
			...snap,
			runs: [
				...snap.runs,
				{ ...snap.runs[0]!, id: "quit", status: "paused", exitReason: "quit", quitAt: now },
				{ ...snap.runs[0]!, id: "done", status: "completed", endedAt: now },
				{ ...snap.runs[0]!, id: "failed", status: "failed", endedAt: now },
				{
					...snap.runs[0]!,
					id: "hil",
					stages: [{ id: "hil-stage", name: "question", status: "awaiting_input", parentIds: [], toolEvents: [] }],
				},
			],
		},
	];
	for (const theme of [undefined, { fg: (_: string, text: string) => text, bold: (text: string) => text }]) {
		for (const width of widths) {
			for (const combination of combinations) {
				for (const line of buildThemedWidgetLines(combination, theme, width, now)) {
					assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
				}
			}
		}
	}
});

// #3015: the mounted shared list must be bounded, not one viewport per run.
test("mounted workflow list caps rows and keeps offscreen runs reachable without remounting", async () => {
	const { createStore } = await import("../../packages/workflows/src/shared/store.js");
	const { installStoreWidget, scrollStoreWidget } = await import(
		"../../packages/workflows/src/tui/store-widget-installer.js"
	);
	const store = createStore();
	for (let i = 0; i < 20; i++)
		store.recordRunStart({
			...snap.runs[0]!,
			id: `reach-${i}`,
			name: `workflow-${i}`,
			status: "paused",
			startedAt: now + i,
		});
	let component: { render(width: number): string[] } | undefined;
	let mounts = 0;
	const host = { terminal: { rows: 40 }, requestRender() {} };
	const dispose = installStoreWidget(
		{
			ui: {
				setWidget(_key, factory) {
					if (factory) {
						mounts++;
						component = factory(host, undefined);
					}
				},
				requestRender() {},
			},
		},
		store,
	);
	try {
		assert.ok(component);
		assert.ok(component.render(120).length <= 10);
		const seen = new Set<string>();
		// Row scrolling visits the full source list, not just twenty pages.
		for (let row = 0; row < 100; row++) {
			const lines = component.render(120);
			for (const run of store.runs()) if (lines.some((line) => line.includes(run.id))) seen.add(run.id);
			scrollStoreWidget(store, 1);
		}
		assert.equal(seen.size, 20);
		for (let row = 0; row < 100; row++) {
			scrollStoreWidget(store, -1);
			component.render(120);
		}
		assert.ok(component.render(120).some((line) => line.includes("reach-19")));
		for (const rows of [6, 9, 12, 18, 24, 40]) {
			host.terminal.rows = rows;
			for (const width of [120, 27, 80, 79, 81]) {
				const lines = component.render(width);
				assert.ok(lines.length <= Math.min(10, Math.floor(rows / 3)));
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				scrollStoreWidget(store, 1);
			}
		}
		for (let i = 0; i < 19; i++) store.removeRun(`reach-${i}`);
		await Promise.resolve();
		assert.ok(component.render(120).some((line) => line.includes("reach-19")));
		store.recordRunEnd("reach-19", "completed");
		await Promise.resolve();
		assert.ok(component.render(120).some((line) => line.includes("complete")));
		store.removeRun("reach-19");
		await Promise.resolve();
		assert.deepEqual(component.render(120), []);
		assert.equal(mounts, 1);
	} finally {
		dispose();
	}
});
