/**
 * Unit tests for the shared renderInputsSchema helper used by:
 *   - renderResult({action: "inputs"}) (LLM tool path)
 *   - /workflow inputs <name> slash command
 *   - /workflow <name> --help slash form
 *   - programmatic SDK validation failures
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.js";

describe("renderInputsSchema", () => {
	test("renders rounded panel with workflow name and per-input cards", () => {
		const out = renderInputsSchema("deep-research", [
			{ name: "prompt", type: "text", required: true, description: "Research topic" },
			{ name: "max_partitions", type: "number", default: 4 },
		]);
		assert.match(out, /╭ INPUTS FOR deep-research /);
		assert.match(out, /prompt {2}text {2}· {2}required/);
		assert.match(out, /Research topic/);
		assert.match(out, /max_partitions {2}number {2}· {2}optional/);
		assert.match(out, /default: 4/);
	});

	test('string default is JSON-quoted (distinguishes "" from absent)', () => {
		const out = renderInputsSchema("flow", [{ name: "label", type: "text", default: "" }]);
		assert.match(out, /label {2}text {2}· {2}optional/);
		assert.match(out, /default: ""/);
	});

	test("boolean default rendered as JSON literal", () => {
		const out = renderInputsSchema("flow", [{ name: "dry", type: "boolean", default: false }]);
		assert.match(out, /dry {2}boolean {2}· {2}optional/);
		assert.match(out, /default: false/);
	});

	test("omits default segment when default is undefined", () => {
		const out = renderInputsSchema("flow", [{ name: "x", type: "text" }]);
		assert.match(out, /x {2}text {2}· {2}optional/);
		assert.doesNotMatch(out, /default:/);
	});

	test("omits description segment when description is absent", () => {
		const out = renderInputsSchema("flow", [{ name: "x", type: "text", required: true }]);
		assert.match(out, /x {2}text {2}· {2}required/);
		assert.doesNotMatch(out, /—/);
	});

	test("empty inputs array reports no declared inputs", () => {
		const out = renderInputsSchema("bare", []);
		assert.match(out, /╭ INPUTS FOR bare /);
		assert.match(out, /Workflow has no declared inputs\./);
	});
});
