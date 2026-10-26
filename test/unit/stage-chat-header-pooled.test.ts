/**
 * The stage chat header keeps a pooled stage's worker status at normal terminal widths (#3996).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import type { StageChatViewContext } from "../../packages/workflows/src/tui/stage-chat-view-types.js";

function header(width: number): string {
	const ctx = {
		theme: deriveGraphTheme({}),
		workflowName: "fan-out-review",
		handle: {
			sessionId: "0f8b5c2e-6d1a-4b7e-9c3f-2a1d4e5b6c7d",
			placement: { kind: "local-worker", workId: "work", generation: 2, reconnecting: true, redelivered: 2 },
		},
	} as never as StageChatViewContext;
	return renderHeader(ctx, width, undefined)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

test("the wrapped stage chat header keeps RECONNECTING and the redelivery count at 80 columns (#3996)", () => {
	for (const width of [80, 160]) {
		const rendered = header(width);
		assert.match(rendered, /on local worker/, `${width} columns`);
		assert.match(rendered, /RECONNECTING/, `${width} columns`);
		assert.match(rendered, /redelivered 2 messages/, `${width} columns`);
		assert.match(rendered, /0f8b5c2e-6d1a-4b7e-9c3f-2a1d4e5b6c7d/, `${width} columns`);
	}
});

test("while its run is republished without the stage, a reconnecting pooled stage's header keeps the stage's name (#3996)", () => {
	const ctx = {
		theme: deriveGraphTheme({}),
		workflowName: "fan-out-review",
		handle: {
			stageName: "work-0",
			sessionId: "session",
			placement: { kind: "local-worker", workId: "work", generation: 2, reconnecting: true },
		},
	} as never as StageChatViewContext;
	const rendered = renderHeader(ctx, 120, undefined)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(rendered, /fan-out-review \/ work-0/);
});
