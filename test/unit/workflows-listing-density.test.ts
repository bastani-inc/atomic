import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { renderAgentPanelRows } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { openWorkflowsListing, workflowsListingItems } from "../../packages/workflows/src/tui/workflows-listing.js";

test("workflow sheet uses every fitting row at 80x24 with a footer and populated agent panel (#5245)", async () => {
	initTheme("dark");
	const runs = Array.from({ length: 12 }, (_, index) => ({
		id: `run-${index}`,
		name: "ralph",
		status: "running",
		inputs: { objective: `task ${index}` },
		stages: [],
		toolNodes: [],
		startedAt: 100_000 - index,
	})) as RunSnapshot[];
	const definitions = Array.from({ length: 8 }, (_, index) => ({
		normalizedName: `definition-${index}`,
		description: `Start definition ${index}`,
		inputs: {},
	}));
	const labels = new Set(workflowsListingItems(runs, definitions).map((item) => item.label));
	const panel = renderAgentPanelRows(
		runs.map((run) => ({
			id: run.id,
			kind: "workflow",
			state: "running",
			name: run.name,
			task: "plan",
			elapsedMs: 1_000,
		})),
		80,
		themedAgentPanelStyle(),
		{},
	);
	assert.equal(panel.length, 5);
	const transcriptRow = 1;
	const usageRow = 1;
	const footerRows = 2;
	const spacerRow = 1;
	const externalRows = transcriptRow + usageRow + footerRows + spacerRow + panel.length;
	let component: PiCustomComponent | undefined;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ terminal: { rows: 24 }, requestRender() {} }, undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs: () => runs, definitions: () => definitions },
	);
	try {
		assert.ok(component);
		for (let step = 0; step <= labels.size; step++) {
			const lines: string[] = component
				.render(80)
				.map((line) => stripVTControlCharacters(line.replace(/\x1b_pi:[^\x07]*\x07/g, "")));
			const visible: number = lines.filter((line) => labels.has(line.trim().replace(/^❯\s+/, ""))).length;
			const chrome: number = lines.length - visible * 2;
			assert.ok(visible >= 5, `step ${step}: only ${visible} rows visible`);
			assert.ok(lines.length + externalRows <= 24, `step ${step}: content exceeds terminal height`);
			assert.equal(visible, Math.floor((24 - externalRows - chrome) / 2), `step ${step}: unused row space`);
			assert.match(lines[0]!, /Workflows.*Search…/);
			assert.match(lines.join("\n"), /❯/);
			component.handleInput?.("\x1b[B");
		}
	} finally {
		component?.dispose?.();
		await pending;
	}
});

test("workflow sheet escapes pasted terminal commands in its search field (#5245)", async () => {
	initTheme("dark");
	let component: PiCustomComponent | undefined;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ terminal: { rows: 24 }, requestRender() {} }, undefined, undefined, () =>
						resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs: () => [], definitions: () => [] },
	);
	try {
		assert.ok(component);
		component.handleInput?.("\x1b[200~\x1b]52;c;QVVESVQ=\x07\x1b[201~");
		assert.equal(component.render(80).join("\n").includes("\x1b]52;"), false);
	} finally {
		component?.dispose?.();
		await pending;
	}
});
