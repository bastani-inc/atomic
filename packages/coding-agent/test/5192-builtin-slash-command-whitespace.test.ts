import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@bastani/atomic-tui";
import { describe, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";

const SEPARATORS = [
	["space", " "],
	["tab", "\t"],
	["newline", "\n"],
	["CRLF", "\r\n"],
] as const;

type Call = readonly [string, ...Array<string | undefined>];

type SubmitContext = Record<string, unknown> & {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
};

type SubmitPrototype = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getPathCommandArgument(this: SubmitContext, text: string, command: "/export" | "/import"): string | undefined;
};

const prototype = InteractiveMode.prototype as unknown as SubmitPrototype;

/** Submit `text` through the interactive editor and return the built-in handler calls it made. */
async function submit(text: string): Promise<Call[]> {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		async (...args: Array<string | undefined>) => {
			calls.push([name, ...args]);
		};
	const runtimeHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	Object.defineProperty(runtimeHost, "openTaskInspector", { value: record("openTaskInspector") });
	const context: SubmitContext = {
		defaultEditor: {},
		editor: { addToHistory: () => {}, setText: () => {}, getText: () => "" },
		ui: { requestRender: () => {} },
		runtimeHost,
		firstSubmitRecorded: true,
		startupReplayInputs: [],
		// Text that no built-in claims reaches the session as an ordinary prompt.
		deferredStartupPending: true,
		ensureDeferredStartupComplete: async () => {},
		// No extension has registered a command.
		isExtensionCommand: () => false,
		session: {
			prompt: record("prompt"),
			compactionReason: undefined,
			// `/model <name>` looks the name up among the models already known before it runs.
			scopedModels: [],
			modelRuntime: { getAvailableSnapshot: () => [] },
		},
		compactionActive: false,
		manualCompactionTakeoverPending: false,
		getPathCommandArgument: prototype.getPathCommandArgument,
		handleExportCommand(this: SubmitContext, value: string) {
			calls.push(["export", prototype.getPathCommandArgument.call(this, value, "/export")]);
		},
		handleImportCommand(this: SubmitContext, value: string) {
			calls.push(["import", prototype.getPathCommandArgument.call(this, value, "/import")]);
		},
		handleNameCommand: async (value: string) => calls.push(["name", value.replace(/^\/name\s*/, "").trim()]),
		showSettingsSelector: record("showSettingsSelector"),
		showModelsSelector: record("showModelsSelector"),
		handleModelCommand: record("handleModelCommand"),
		handleThinkingCommand: record("handleThinkingCommand"),
		handleShareCommand: record("handleShareCommand"),
		handleCopyCommand: record("handleCopyCommand"),
		handleSessionCommand: record("handleSessionCommand"),
		handleSessionSnapshotCommand: record("handleSessionSnapshotCommand"),
		handleToolsCommand: record("handleToolsCommand"),
		handleChangelogCommand: record("handleChangelogCommand"),
		handleHotkeysCommand: record("handleHotkeysCommand"),
		showUserMessageSelector: record("showUserMessageSelector"),
		handleCloneCommand: record("handleCloneCommand"),
		showTreeSelector: record("showTreeSelector"),
		showTrustSelector: record("showTrustSelector"),
		handleLoginCommand: record("handleLoginCommand"),
		showOAuthSelector: record("showOAuthSelector"),
		handleClearCommand: record("handleClearCommand"),
		handleCompactCommand: record("handleCompactCommand"),
		handleReloadCommand: record("handleReloadCommand"),
		handleDebugCommand: record("handleDebugCommand"),
		handleArminSaysHi: record("handleArminSaysHi"),
		handleDementedDelves: record("handleDementedDelves"),
		showSessionSelector: record("showSessionSelector"),
		handleResumeTarget: record("handleResumeTarget"),
		shutdown: record("shutdown"),
		showWarning: record("showWarning"),
	};
	prototype.setupEditorSubmitHandler.call(context);
	await context.defaultEditor.onSubmit?.(text);
	return calls;
}

/** Built-ins that read an argument, with the call each makes for `/name<separator><argument>`. */
const ARGUMENT_COMMANDS: ReadonlyArray<{ name: string; argument: string; expected: Call }> = [
	{ name: "tasks", argument: "agent-1", expected: ["openTaskInspector", "agent-1"] },
	{ name: "resume", argument: "aaaaaaaa", expected: ["handleResumeTarget", "aaaaaaaa"] },
	{ name: "model", argument: "opus", expected: ["handleModelCommand", "opus"] },
	{ name: "thinking", argument: "high", expected: ["handleThinkingCommand", "high"] },
	{ name: "export", argument: "out.jsonl", expected: ["export", "out.jsonl"] },
	{ name: "import", argument: "in.jsonl", expected: ["import", "in.jsonl"] },
	{ name: "name", argument: "my session", expected: ["name", "my session"] },
	{ name: "session", argument: "snapshot", expected: ["handleSessionSnapshotCommand"] },
	{ name: "login", argument: "anthropic", expected: ["handleLoginCommand", "anthropic"] },
	{ name: "logout", argument: "anthropic", expected: ["showOAuthSelector", "logout", "anthropic"] },
	{ name: "compact", argument: "focus on X", expected: ["handleCompactCommand", "focus on X"] },
];

/** Built-ins that take no argument, with the call each makes when submitted bare. */
const BARE_COMMANDS: ReadonlyArray<{ name: string; expected: Call; withText?: Call }> = [
	{ name: "settings", expected: ["showSettingsSelector"] },
	{ name: "scoped-models", expected: ["showModelsSelector"] },
	{ name: "share", expected: ["handleShareCommand"] },
	{ name: "copy", expected: ["handleCopyCommand"] },
	{ name: "session", expected: ["handleSessionCommand"] },
	{ name: "tools", expected: ["handleToolsCommand"] },
	{ name: "changelog", expected: ["handleChangelogCommand"] },
	{ name: "hotkeys", expected: ["handleHotkeysCommand"] },
	{ name: "fork", expected: ["showUserMessageSelector"] },
	{ name: "clone", expected: ["handleCloneCommand"] },
	{ name: "tree", expected: ["showTreeSelector"] },
	{ name: "trust", expected: ["showTrustSelector"] },
	{ name: "new", expected: ["handleClearCommand"] },
	{ name: "reload", expected: ["handleReloadCommand"] },
	{ name: "resume", expected: ["showSessionSelector"], withText: ["handleResumeTarget", "extra"] },
	{ name: "exit", expected: ["shutdown"] },
	{ name: "quit", expected: ["shutdown"] },
	{ name: "debug", expected: ["handleDebugCommand"] },
	{ name: "arminsayshi", expected: ["handleArminSaysHi"] },
	{ name: "dementedelves", expected: ["handleDementedDelves"] },
];

describe("built-in slash commands split their name at the first whitespace (#5192)", () => {
	test("resume advertises saved sessions in the command menu (#5224)", () => {
		const description = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "resume")?.description ?? "";
		assert.equal(description, "Resume a session");
	});

	test("the tables cover every built-in in the command menu (#5192)", () => {
		const covered = new Set([...ARGUMENT_COMMANDS, ...BARE_COMMANDS].map((entry) => entry.name));
		const missing = BUILTIN_SLASH_COMMANDS.map((command) => command.name).filter((name) => !covered.has(name));
		assert.deepEqual(missing, []);
	});

	for (const [label, separator] of SEPARATORS) {
		for (const { name, argument, expected } of ARGUMENT_COMMANDS) {
			test(`/${name} reads an argument after a ${label} (#5192)`, async () => {
				assert.deepEqual(await submit(`/${name}${separator}${argument}`), [expected]);
			});
		}

		for (const { name, expected, withText: textHandler } of BARE_COMMANDS) {
			test(`/${name} runs bare and routes text after a ${label} (#5192)`, async () => {
				assert.deepEqual(await submit(`/${name}`), [expected]);
				const withText = `/${name}${separator}extra`;
				assert.deepEqual(await submit(withText), [textHandler ?? ["prompt", withText]]);
			});
		}
	}

	test("a quoted /export path after a tab keeps its spaces (#5192)", async () => {
		assert.deepEqual(await submit('/export\t"my session.html"'), [["export", "my session.html"]]);
	});
});

describe("slash command autocomplete splits at the first whitespace (#5192)", () => {
	const provider = new CombinedAutocompleteProvider(
		[
			{
				name: "model",
				description: "Select model",
				getArgumentCompletions: (prefix) => [{ value: `${prefix}-completed`, label: "completed" }],
			},
		],
		process.cwd(),
	);

	for (const [label, separator] of SEPARATORS.filter(([, value]) => !value.includes("\n"))) {
		test(`completes arguments after a ${label} (#5192)`, async () => {
			const line = `/model${separator}op`;
			const suggestions = await provider.getSuggestions([line], 0, line.length, {
				signal: new AbortController().signal,
			});
			assert.deepEqual(suggestions, { items: [{ value: "op-completed", label: "completed" }], prefix: "op" });
		});
	}

	test("parses a /workflow-authoring request argument after a tab (#5192)", () => {
		assert.deepEqual(parseSlashCommand("/workflow-authoring\tWrite a release workflow"), {
			name: "workflow-authoring",
			args: "Write a release workflow",
		});
	});
});
