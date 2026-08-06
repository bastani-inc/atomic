/**
 * Statusline chrome of the workflow orchestrator overlay.
 *
 * Verifies:
 *  - Host MCP server counts stay in main chat and never reach the graph
 *    statusline, which is reserved for run-scoped hints.
 *  - Other extension statuses (e.g. async subagents) still render there.
 *  - Workflow-owned status keys are never echoed back into the overlay.
 *
 * cross-ref: packages/workflows/src/tui/graph-view-render-helpers.ts
 */

import assert from "node:assert/strict";
import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import { describe, test } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { defaultTheme, makeSnap, makeStage, makeStore, visibleText } from "./overlay-graph-helpers.js";

function footerData(statuses: Map<string, string>): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

function renderOverlay(statuses: Map<string, string>): string {
	const view = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([{ ...makeStage("stage-1"), status: "running" }])),
		graphTheme: defaultTheme,
		footerData: footerData(statuses),
		getViewportRows: () => 20,
	});
	try {
		return visibleText(view.render(100));
	} finally {
		view.dispose();
	}
}

describe("workflow orchestrator statusline extension statuses", () => {
	test("hides the host MCP server count while preserving other extension statuses", () => {
		const rendered = renderOverlay(
			new Map([
				["mcp", "MCP: 0/1 servers"],
				["other-extension", "Other extension status"],
			]),
		);

		assert.doesNotMatch(rendered, /MCP:/);
		assert.match(rendered, /Other extension status/);
	});

	test("hides workflow-owned status keys", () => {
		const rendered = renderOverlay(
			new Map([
				["pi-workflows", "pi-workflows/test-wf"],
				["pi-workflows:main-chat-input", "Main chat needs input"],
			]),
		);

		assert.doesNotMatch(rendered, /pi-workflows/);
	});
});
