// @ts-nocheck
import { describe, test } from "vitest";
import {
	assert,
	installSlashDispatchTestHooks,
	parseWorkflowArgs,
	tokenizeWorkflowArgs,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("parseWorkflowArgs", () => {
	test.sequential("empty tokens → empty object", () => {
		assert.deepEqual(parseWorkflowArgs([]), {});
	});

	test.sequential("parses key=value string pairs", () => {
		assert.deepEqual(parseWorkflowArgs(["prompt=hello world"]), {
			prompt: "hello world",
		});
	});

	test.sequential("multiple key=value pairs", () => {
		assert.deepEqual(parseWorkflowArgs(["a=1", "b=foo"]), {
			a: 1,
			b: "foo",
		});
	});

	test.sequential("JSON-typed values: number, boolean", () => {
		assert.deepEqual(parseWorkflowArgs(["count=42", "flag=true"]), {
			count: 42,
			flag: true,
		});
	});

	test.sequential("value with = in it splits on first = only", () => {
		assert.deepEqual(parseWorkflowArgs(["url=http://x.com/a=b"]), {
			url: "http://x.com/a=b",
		});
	});

	test.sequential("JSON object token merged into result", () => {
		const result = parseWorkflowArgs(['{"key":"val","n":3}']);
		assert.deepEqual(result, { key: "val", n: 3 });
	});

	test.sequential("JSON object merged with key=value", () => {
		const result = parseWorkflowArgs(['{"a":1}', "b=two"]);
		assert.deepEqual(result, { a: 1, b: "two" });
	});

	test.sequential("tokens without = are ignored", () => {
		assert.deepEqual(parseWorkflowArgs(["positional", "another"]), {});
	});

	test.sequential("key with empty value", () => {
		assert.deepEqual(parseWorkflowArgs(["name="]), { name: "" });
	});
});

// ---------------------------------------------------------------------------
// tokenizeWorkflowArgs
// ---------------------------------------------------------------------------

describe("tokenizeWorkflowArgs", () => {
	test.sequential("empty string → empty array", () => {
		assert.deepEqual(tokenizeWorkflowArgs(""), []);
	});

	test.sequential("whitespace-only string → empty array", () => {
		assert.deepEqual(tokenizeWorkflowArgs("   \t  "), []);
	});

	test.sequential("plain whitespace split for bare tokens", () => {
		assert.deepEqual(tokenizeWorkflowArgs("workflow-name a=1 b=foo"), ["workflow-name", "a=1", "b=foo"]);
	});

	test.sequential("double-quoted value preserves internal whitespace", () => {
		// Regression: `prompt="map the codebase"` used to split into three
		// tokens (`prompt="map`, `the`, `codebase"`), which then rendered as
		// `prompt=""map"` in the dispatch confirm card.
		assert.deepEqual(tokenizeWorkflowArgs('workflow-name prompt="map the codebase" max=4'), [
			"workflow-name",
			'prompt="map the codebase"',
			"max=4",
		]);
	});

	test.sequential("single-quoted value preserves internal whitespace", () => {
		assert.deepEqual(tokenizeWorkflowArgs("wf prompt='hello there' n=2"), ["wf", "prompt='hello there'", "n=2"]);
	});

	test.sequential("nested quotes of the opposite kind are treated as literal characters", () => {
		assert.deepEqual(tokenizeWorkflowArgs(`wf msg="she said 'hi'"`), ["wf", `msg="she said 'hi'"`]);
	});

	test.sequential("unterminated quote is recovered as a single tail token", () => {
		// The user can paste a partial value mid-typing; we never throw on
		// their input, the downstream JSON parse just falls back to string.
		assert.deepEqual(tokenizeWorkflowArgs('wf prompt="map the codebase'), ["wf", 'prompt="map the codebase']);
	});

	test.sequential("collapses runs of whitespace", () => {
		assert.deepEqual(tokenizeWorkflowArgs("a   b\t\tc"), ["a", "b", "c"]);
	});

	test.sequential("end-to-end: tokenize + parse unquotes the string value", () => {
		const tokens = tokenizeWorkflowArgs('fan-out-and-synthesize prompt="map the codebase" max_branches=4');
		assert.deepEqual(tokens, ["fan-out-and-synthesize", 'prompt="map the codebase"', "max_branches=4"]);
		assert.deepEqual(parseWorkflowArgs(tokens.slice(1)), {
			prompt: "map the codebase",
			max_branches: 4,
		});
	});
});

// ---------------------------------------------------------------------------
// Shared test factory helpers
