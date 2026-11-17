import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";

describe("renderResult({ action: 'inputs' })", () => {
	test("renders workflow name and per-input fields", () => {
		const out = renderResult({
			action: "inputs",
			name: "deep-research",
			inputs: [
				{ name: "prompt", type: "text", required: true, description: "Research topic" },
				{ name: "max_partitions", type: "number", default: 4 },
			],
		});
		assert.match(out, /^INPUTS FOR deep-research$/m);
		assert.match(out, /prompt {2}text · required/);
		assert.match(out, /Research topic/);
		assert.match(out, /max_partitions {2}number · optional/);
		assert.match(out, /default: 4/);
	});

	test('string default is JSON-quoted (distinguishes "" from absent)', () => {
		const out = renderResult({
			action: "inputs",
			name: "flow",
			inputs: [{ name: "label", type: "text", default: "" }],
		});
		assert.match(out, /label {2}text · optional/);
		assert.match(out, /default: ""/);
	});

	test("boolean default rendered as JSON literal", () => {
		const out = renderResult({
			action: "inputs",
			name: "flow",
			inputs: [{ name: "dry", type: "boolean", default: false }],
		});
		assert.match(out, /dry {2}boolean · optional/);
		assert.match(out, /default: false/);
	});

	test("omits default segment when default is undefined", () => {
		const out = renderResult({
			action: "inputs",
			name: "flow",
			inputs: [{ name: "x", type: "text" }],
		});
		assert.match(out, /x {2}text · optional/);
		assert.doesNotMatch(out, /default:/);
	});

	test("omits description segment when description is absent", () => {
		const out = renderResult({
			action: "inputs",
			name: "flow",
			inputs: [{ name: "x", type: "text", required: true }],
		});
		assert.match(out, /x {2}text · required/);
		assert.doesNotMatch(out, /—/);
	});

	test("empty inputs array reports no declared inputs", () => {
		const out = renderResult({ action: "inputs", name: "bare", inputs: [] });
		assert.match(out, /^INPUTS FOR bare$/m);
		assert.match(out, /Workflow has no declared inputs\./);
	});
});
