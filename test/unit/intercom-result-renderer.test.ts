import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderIntercomResult } from "../../packages/intercom/result-renderers.js";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Parameters<typeof renderIntercomResult>[2];

function render(details: { delivered: boolean; queued?: boolean }, text: string): string {
	const result = {
		content: [{ type: "text" as const, text }],
		details,
	};
	return renderIntercomResult(result, { expanded: false, isPartial: false }, theme, {
		args: {},
		toolCallId: "test-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: "/workspace",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	})
		.render(200)
		.join("\n");
}

describe("intercom result rendering", () => {
	// Regression: #2784
	test("renders queued sends as successful while preserving genuine delivery failures", () => {
		const queued = render({ delivered: false, queued: true }, "Message queued for workflow:stage");
		assert.match(queued, /<success>✓ <\/success><text>Message queued for workflow:stage<\/text>/);
		assert.doesNotMatch(queued, /<error>/);

		const undelivered = render({ delivered: false }, "Message was not delivered");
		assert.match(undelivered, /<error>✗ <\/error><error>Message was not delivered<\/error>/);
		assert.doesNotMatch(undelivered, /<success>/);
	});
});
