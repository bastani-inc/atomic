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
	const rootSuggestions = await suggest("/workflow ");
	assert.ok(rootSuggestions);
	assert.deepEqual(
		rootSuggestions.items
			.filter((item) => !item.description?.startsWith("Run workflow:"))
			.map((item) => ({ value: item.value, label: item.label, description: item.description })),
		[
			{ value: "list ", label: "list", description: "List registered workflows" },
			{ value: "status ", label: "status", description: "List current-session active and retained terminal runs" },
			{ value: "pause ", label: "pause", description: "Pause a run" },
			{ value: "quit ", label: "quit", description: "Quit a run and keep it resumable" },
			{ value: "resume ", label: "resume", description: "Re-open overlay for a run" },
			{ value: "fork ", label: "fork", description: "Fork a run into a new run, optionally --from a stage" },
			{ value: "inputs ", label: "inputs", description: "Show a workflow's input schema" },
			{ value: "reload ", label: "reload", description: "Reload workflow resources" },
		],
	);

	const commands = await suggest("/workfl");
	const workflow = commands?.items.find((item) => item.value === "workflow");
	assert.ok(workflow);
	assert.equal(
		workflow.description,
		"Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|quit|pause|resume|inputs|reload] [args] | /workflow fork <run> [--from <stage>]",
	);

	for (const [prefix, expected] of [
		["sta", ["status "]],
		["res", ["resume "]],
		["for", ["fork "]],
		["fork -", ["fork --from "]],
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

test("bundled workflow fallback offers fork --from once before --from is present (#5224)", async () => {
	const runPrefix = "a1b2c3d4";
	assert.deepEqual(
		(await suggest(`/workflow fork ${runPrefix} `))?.items.map((item) => item.value),
		[`fork ${runPrefix} --from `],
	);
	assert.deepEqual(
		(await suggest(`/workflow fork ${runPrefix} --f`))?.items.map((item) => item.value),
		[`fork ${runPrefix} --from `],
	);
	assert.equal(await suggest(`/workflow fork ${runPrefix} --from=s1`), null);
});

test.each([
	"/workflow fork --from ",
	"/workflow fork a1b2c3d4 --from ",
	"/workflow fork a1b2c3d4 --from -",
	"/workflow fork a1b2c3d4 --from s1 ",
	"/workflow fork a1b2c3d4 --from s1 --f",
	"/workflow fork a1b2c3d4 --from=s1 ",
	"/workflow fork a1b2c3d4 --from=s1 --f",
])("bundled workflow fallback omits duplicate fork --from for %s (#5224)", async (line) => {
	assert.equal(await suggest(line), null);
});

test.each(["/workflow pause a1b2c3d4 ", "/workflow pause a1b2c3d4 -", "/workflow pause --yes a1b2c3d4 "])(
	"bundled workflow fallback omits pause flags after positional run in %s (#5224)",
	async (line) => {
		assert.deepEqual(
			(await suggest("/workflow pause --yes -"))?.items.map((item) => item.value),
			["pause --yes --all ", "pause --yes --yes ", "pause --yes -y "],
		);
		assert.equal(await suggest(line), null);
	},
);
