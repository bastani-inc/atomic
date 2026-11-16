// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { handleWorkflowsCommand } from "../../packages/workflows/src/extension/workflow-open-run.js";
import { invalidDefinitionsFromDiagnostics } from "../../packages/workflows/src/tui/workflows-listing.js";
import * as h from "./overlay-graph-helpers.js";

const PARSE_ERROR = [
	"Error: Workflow file failed to import: Unexpected token ')' (12:4)",
	"    at importWorkflow (/atomic/discovery.ts:88:9)",
	"    at async discover (/atomic/discovery.ts:120:3)",
].join("\n");

const DIAGNOSTICS = [
	{ level: "error", code: "IMPORT_FAILED", source: "/repo/.atomic/workflows/greet.ts", message: PARSE_ERROR },
	{ level: "error", code: "INVALID_DEFINITION", source: "deploy", message: "Definition has no stages" },
	{ level: "warn", code: "DUPLICATE_NAME", source: "ralph", message: "Skipped a duplicate" },
	{ level: "warn", code: "ZERO_STAGES", source: "lint", message: "No stage call sites found" },
];

function harness(definitions = [], invalid = DIAGNOSTICS) {
	const opened = [];
	const messages = { info: [], error: [] };
	const pickers = [];
	const started = [];
	const ctx = {
		hasUI: true,
		ui: {
			custom: (factory) => {
				pickers.push(factory);
				return Promise.resolve(undefined);
			},
		},
	};
	const deps = {
		overlay: { open: (runId) => opened.push(runId) },
		store: h.makeStore({ runs: [], notices: [], version: 1 }),
		definitions: () => definitions,
		invalidDefinitions: () => invalidDefinitionsFromDiagnostics(invalid),
		startDefinition: async (name) => {
			started.push(name);
		},
	};
	const reporter = { info: (m) => messages.info.push(m), error: (m) => messages.error.push(m) };
	return { opened, messages, pickers, started, ctx, deps, reporter };
}

describe("workflow definition errors before launch (#5224)", () => {
	it("keeps only the diagnostics that stopped a definition from loading, named by workflow", () => {
		const invalid = invalidDefinitionsFromDiagnostics(DIAGNOSTICS);
		assert.deepEqual(
			invalid.map((entry) => [entry.name, entry.reason]),
			[
				["greet", "Workflow file failed to import: Unexpected token ')' (12:4)"],
				["deploy", "Definition has no stages"],
			],
		);
	});

	it("lists a definition that failed to load as ✗ with its one-line reason; Enter explains it instead of starting it", async () => {
		initTheme("dark");
		const t = harness([{ normalizedName: "ralph", description: "iterate a fix", inputs: {} }]);
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, t.deps);
		await Promise.resolve();
		assert.equal(t.pickers.length, 1);
		const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		const text = stripAnsi(component.render(120).join("\n"));
		assert.match(text, /greet/);
		assert.match(text, /failed to load · Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.match(text, /✗/);
		assert.doesNotMatch(text, /at importWorkflow/);
		// The selector lists Definitions by name: deploy, greet, ralph.
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		await pending;
		assert.deepEqual(t.started, [], "a broken definition never starts");
		const shown = t.messages.error.join("\n");
		assert.match(shown, /✗ Workflow "greet" could not be loaded/);
		assert.match(shown, /file\s+\/repo\/\.atomic\/workflows\/greet\.ts/);
		assert.match(shown, /reason\s+Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.match(shown, /Fix the file, then run \/workflow reload/);
		assert.doesNotMatch(shown, /at importWorkflow/, "no stack frame, even in the details");
		assert.match(shown, /2 stack frames hidden/);
	});

	it("opens the sheet when the only definitions are broken, instead of saying there are no workflows", async () => {
		initTheme("dark");
		const t = harness([]);
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, t.deps);
		await Promise.resolve();
		assert.equal(t.pickers.length, 1);
		assert.deepEqual(t.messages.info, []);
		const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		component.handleInput("\x1b");
		await pending;
	});

	it("a workflow tool error card shows the message without its stack frames", () => {
		const card = stripAnsi(renderResult(null, { errorText: PARSE_ERROR, width: 100 }));
		assert.match(card, /Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.doesNotMatch(card, /at importWorkflow/);
		assert.match(card, /2 stack frames hidden/);
	});
});
