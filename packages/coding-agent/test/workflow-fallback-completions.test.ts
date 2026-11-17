import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, type EditorTheme, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	REMOVED_WORKFLOW_COMMAND_NOTICE,
	registerWorkflowSlashCommand,
} from "../../workflows/src/extension/workflow-command-registration.js";
import {
	installInputInterceptor,
	type WorkflowCommandHandler,
} from "../../workflows/src/extension/workflow-command-utils.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BUILTIN_SLASH_COMMANDS, BUNDLED_EXTENSION_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { createChatAutocompleteProvider } from "../src/modes/interactive/chat-autocomplete.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const provider = new CombinedAutocompleteProvider(
	[...BUILTIN_SLASH_COMMANDS, ...BUNDLED_EXTENSION_SLASH_COMMANDS],
	process.cwd(),
);

async function suggest(line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

test("bundled slash commands offer only /workflows and /workflow-authoring for workflows (#5224)", async () => {
	const workflowBundled = BUNDLED_EXTENSION_SLASH_COMMANDS.filter((command) => command.name.startsWith("workflow"));
	assert.deepEqual(workflowBundled, [
		{ name: "workflows", description: "Browse running and completed workflows" },
		{ name: "workflow-authoring", description: "Load the reference for writing workflow definitions" },
	]);
	assert.equal(
		BUILTIN_SLASH_COMMANDS.some((command) => command.name.startsWith("workflow")),
		false,
	);

	const suggestions = await suggest("/workflow");
	assert.ok(suggestions);
	assert.deepEqual(
		suggestions.items
			.filter((item) => item.value.startsWith("workflow"))
			.map((item) => ({ value: item.value, description: item.description })),
		[
			{ value: "workflows", description: "Browse running and completed workflows" },
			{ value: "workflow-authoring", description: "Load the reference for writing workflow definitions" },
		],
	);
	assert.equal(
		suggestions.items.some((item) => item.value === "workflow"),
		false,
	);
});

test("bundled fallback completes /workflows and /workflow-authoring and never completes /workflow subcommands (#5224)", async () => {
	const line = "/workfl";
	const suggestions = await suggest(line);
	assert.ok(suggestions);
	const workflows = suggestions.items.find((item) => item.value === "workflows");
	const authoring = suggestions.items.find((item) => item.value === "workflow-authoring");
	assert.ok(workflows);
	assert.ok(authoring);
	assert.equal(workflows.description, "Browse running and completed workflows");
	assert.equal(authoring.description, "Load the reference for writing workflow definitions");
	assert.deepEqual(provider.applyCompletion([line], 0, line.length, workflows, suggestions.prefix), {
		lines: ["/workflows "],
		cursorLine: 0,
		cursorCol: "/workflows ".length,
	});
	assert.deepEqual(provider.applyCompletion([line], 0, line.length, authoring, suggestions.prefix), {
		lines: ["/workflow-authoring "],
		cursorLine: 0,
		cursorCol: "/workflow-authoring ".length,
	});

	for (const removedLine of [
		"/workflow ",
		"/workflow list",
		"/workflow status",
		"/workflow pause",
		"/workflow quit",
		"/workflow resume",
		"/workflow fork",
		"/workflow inputs",
		"/workflow reload",
		"/workflows ",
		"/workflow-authoring ",
	]) {
		assert.equal(await suggest(removedLine), null, removedLine);
	}
});

const testEditorTheme: EditorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

function createTestTui(columns = 80, rows = 24): TUI {
	return {
		requestRender() {},
		terminal: { columns, rows },
	} as unknown as TUI;
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

test("bare /workflow + Enter submits /workflow for the removal notice while Tab completes /workflows and other prefixes confirm on Enter (#5224)", async () => {
	initTheme("dark", false);
	const keybindings = new KeybindingsManager();
	const chatProvider = createChatAutocompleteProvider(
		[...BUILTIN_SLASH_COMMANDS, ...BUNDLED_EXTENSION_SLASH_COMMANDS],
		process.cwd(),
		null,
	);
	const editor = new CustomEditor(createTestTui(80, 24), testEditorTheme, keybindings);
	editor.setAutocompleteProvider(chatProvider);

	const submissions: string[] = [];
	editor.onSubmit = (text) => {
		submissions.push(text);
	};

	for (const ch of "/workflow") editor.handleInput(ch);
	await flushAutocomplete();
	assert.equal(editor.isShowingAutocomplete(), true);

	for (const width of [80, 160] as const) {
		const rendered = editor.render(width);
		for (const line of rendered) {
			assert.ok(visibleWidth(line) <= width, `width ${width} overflowed: ${visibleWidth(line)}`);
		}
		const joined = rendered.join("\n");
		assert.match(joined, /workflows/);
		assert.match(joined, /workflow-authoring/);
	}

	editor.handleInput("\r");
	assert.deepEqual(submissions, ["/workflow"]);

	const handlers = new Map<string, WorkflowCommandHandler>();
	const notices: string[] = [];
	let openedWorkflows = 0;
	let modelTurns = 0;
	let inputHandler:
		| ((event: { text: string; source: string }, ctx: unknown) => Promise<{ action: string } | undefined>)
		| undefined;
	registerWorkflowSlashCommand(
		{
			registerCommand(name, options) {
				if (name === "workflows") {
					options.handler = async () => {
						openedWorkflows += 1;
					};
				}
			},
			on(event, handler) {
				if (event === "input") inputHandler = handler as typeof inputHandler;
			},
		},
		handlers,
		{
			overlay: {
				open: () => {
					openedWorkflows += 1;
				},
				toggle: () => {},
				close: () => {},
			},
		},
	);
	installInputInterceptor(
		{
			on(event, handler) {
				if (event === "input") inputHandler = handler as typeof inputHandler;
			},
		},
		handlers,
	);
	assert.ok(inputHandler);
	const intercepted = await inputHandler(
		{ text: submissions[0]!, source: "interactive" },
		{
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
			},
		},
	);
	if (!intercepted) modelTurns += 1;
	assert.deepEqual(intercepted, { action: "handled" });
	assert.equal(openedWorkflows, 0);
	assert.equal(modelTurns, 0);
	assert.deepEqual(notices, [REMOVED_WORKFLOW_COMMAND_NOTICE]);

	for (const ch of "/workflow") editor.handleInput(ch);
	await flushAutocomplete();
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.handleInput("\t");
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.equal(editor.getText(), "/workflows ");
	editor.handleInput("\r");
	assert.equal(submissions.at(-1), "/workflows");

	for (const ch of "/workflow") editor.handleInput(ch);
	await flushAutocomplete();
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	assert.equal(submissions.at(-1), "/workflow-authoring");

	for (const [typed, expected] of [
		["/work", "/workflows"],
		["/workfl", "/workflows"],
		["/workflows", "/workflows"],
		["/workflow-", "/workflow-authoring"],
		["/mod", "/model"],
	] as const) {
		for (const ch of typed) editor.handleInput(ch);
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true, typed);
		editor.handleInput("\r");
		assert.equal(submissions.at(-1), expected, typed);
	}
});
