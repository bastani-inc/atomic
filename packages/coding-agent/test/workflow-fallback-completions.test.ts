import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@bastani/atomic-tui";
import { test } from "vitest";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../src/core/slash-commands.js";

const provider = new CombinedAutocompleteProvider([...BUNDLED_EXTENSION_SLASH_COMMANDS], process.cwd());

async function suggest(line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

test("bundled workflow fallback omits removed connect and attach commands (#5224)", async () => {
	const suggestions = await suggest("/workflow ");
	assert.ok(suggestions);
	const labels = suggestions.items.map((item) => item.label);
	for (const removed of ["connect", "attach"]) {
		assert.equal(labels.includes(removed), false, `${removed} must not be offered`);
	}
	assert.equal(await suggest("/workflow con"), null);
	assert.equal(await suggest("/workflow att"), null);
	const commands = await suggest("/workfl");
	const workflow = commands?.items.find((item) => item.value === "workflow");
	assert.ok(workflow);
	assert.doesNotMatch(workflow.description ?? "", /\b(?:connect|attach)\b/);
});

test("bundled fallback completes /workflows as a separate run browser (#5224)", async () => {
	const line = "/workfl";
	const suggestions = await suggest(line);
	assert.ok(suggestions);
	const workflows = suggestions.items.find((item) => item.value === "workflows");
	assert.ok(workflows, "the /workflows run browser must be offered");
	assert.match(workflows.description ?? "", /Usage: \/workflows \[run-id\]/);
	assert.deepEqual(provider.applyCompletion([line], 0, line.length, workflows, suggestions.prefix), {
		lines: ["/workflows "],
		cursorLine: 0,
		cursorCol: "/workflows ".length,
	});
	assert.equal(await suggest("/workflows "), null);
});

test("bundled workflow fallback retains inspection, resume and run controls (#5224)", async () => {
	for (const [prefix, expected] of [
		["sta", ["status "]],
		["res", ["resume "]],
		["pause -", ["pause --all ", "pause --yes ", "pause -y "]],
		["quit -", ["quit --all "]],
		["inputs fan", ["inputs fan-out-and-synthesize "]],
	] as const) {
		assert.deepEqual(
			(await suggest(`/workflow ${prefix}`))?.items.map((item) => item.value),
			expected,
		);
	}
	assert.equal(await suggest("/workflow status "), null);
	assert.equal(await suggest("/workflow resume "), null);
});
