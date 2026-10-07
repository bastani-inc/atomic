import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterAll, describe, test } from "vitest";
import { computeStartupInputCaptureEnabled } from "../../packages/coding-agent/src/main-deferred-startup.js";
import {
	applyEarlyInputChunk,
	type EarlyInputCapture,
	type EarlyInputState,
} from "../../packages/coding-agent/src/main-early-input.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { seedStartupInput } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import type { InteractiveSubmission } from "../../packages/coding-agent/src/modes/interactive/interactive-submission.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const explicitPackagePaths = [
	join(testDir, "../../packages/coding-agent/test/fixtures/slash-autosend-extension-package"),
	join(testDir, "../../packages/coding-agent/test/fixtures/slash-autosend-workflow-package"),
];
const startupCwd = mkdtempSync(join(tmpdir(), "atomic-explicit-package-startup-"));

afterAll(() => {
	rmSync(startupCwd, { recursive: true, force: true });
});

interface DraftEditor {
	onSubmit?: (text: string) => void | Promise<void>;
	getText(): string;
	setText(text: string): void;
	setAutocompleteProvider(provider: AutocompleteProvider): void;
}

interface StartupInputContext {
	pendingUserInputs: InteractiveSubmission[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
	options: { startupInputCapture?: EarlyInputCapture };
	defaultEditor: DraftEditor;
	editor: DraftEditor;
	ui: { requestRender(): void };
	autocompleteProviderWrappers: Array<(provider: AutocompleteProvider) => AutocompleteProvider>;
	autocompleteProvider?: AutocompleteProvider;
	createBaseAutocompleteProvider(): AutocompleteProvider;
	deliverStartupReplayPrompt(text: string): void;
	inputHandlerReadyRecorded: boolean;
	onInputCallback?: (submission: InteractiveSubmission) => void;
}

const interactivePrototype = InteractiveMode.prototype as unknown as {
	setupAutocompleteProvider(this: StartupInputContext): void;
	getUserInput(this: StartupInputContext): Promise<InteractiveSubmission>;
	drainStartupReplayCommands(this: StartupInputContext): Promise<void>;
	advanceStartupInputReplay(this: StartupInputContext, submittedText: string): void;
};

const baseProvider: AutocompleteProvider = {
	async getSuggestions() {
		return null;
	},
	applyCompletion(lines, cursorLine, cursorCol) {
		return { lines, cursorLine, cursorCol };
	},
};

function startupCaptureEnabledForExplicitPackages(): boolean {
	return computeStartupInputCaptureEnabled({
		appMode: "interactive",
		stdinIsTTY: true,
		parsed: {
			help: false,
			listModels: undefined,
			projectTrustOverride: true,
			systemPrompt: undefined,
			appendSystemPrompt: [],
			unknownFlags: new Map(),
			provider: undefined,
			model: undefined,
			resume: false,
			session: undefined,
		},
		sessionCwd: startupCwd,
		projectTrustStore: { get: () => null },
		resolvedExtensionPathCount: explicitPackagePaths.length,
		resolvedResourcePathCount: 0,
		deprecationWarningCount: 0,
	});
}

function createStartupContext(
	draft: string,
	capture: EarlyInputCapture | undefined,
): {
	context: StartupInputContext;
	providerInstallations: string[];
	submitted: string[];
} {
	let editorText = "";
	const providerInstallations: string[] = [];
	const submitted: string[] = [];
	const editor: DraftEditor = {
		getText: () => editorText,
		setText: (text) => {
			editorText = text;
		},
		setAutocompleteProvider: () => {
			providerInstallations.push(editorText);
		},
	};
	const context: StartupInputContext = {
		pendingUserInputs: [],
		startupReplayInputs: [],
		inputHandlerReadyRecorded: true,
		options: { startupInputCapture: capture },
		defaultEditor: editor,
		editor,
		ui: { requestRender: () => {} },
		autocompleteProviderWrappers: [],
		createBaseAutocompleteProvider: () => baseProvider,
		deliverStartupReplayPrompt: (text) => {
			context.pendingUserInputs.push({ text, draft: text });
		},
	};
	editor.onSubmit = async (text) => {
		submitted.push(text);
		interactivePrototype.advanceStartupInputReplay.call(context, text);
	};

	if (capture) {
		seedStartupInput(
			context.pendingUserInputs,
			editor,
			capture.consume(),
			context.startupReplayInputs,
			(text) => {
				context.startupDraftText = text;
			},
			(text) => {
				context.startupReplayActiveInput = text;
			},
		);
	} else {
		editor.setText(draft);
	}
	Object.setPrototypeOf(context, InteractiveMode.prototype);
	return { context, providerInstallations, submitted };
}

describe("interactive startup input with explicit packages", () => {
	for (const draft of ["/", "/foo"]) {
		test(`keeps ${JSON.stringify(draft)} as a draft when extension and workflow package loading finishes`, async () => {
			const captureEnabled = startupCaptureEnabledForExplicitPackages();
			assert.equal(captureEnabled, true, "explicit -e packages must keep raw startup input capture enabled");
			const capture = captureEnabled ? { consume: () => ({ text: draft, submissions: [] }) } : undefined;
			const { context, providerInstallations, submitted } = createStartupContext(draft, capture);

			// Package completion publishes the new command catalog and rebuilds autocomplete.
			interactivePrototype.setupAutocompleteProvider.call(context);
			await interactivePrototype.drainStartupReplayCommands.call(context);

			assert.deepEqual(providerInstallations, [draft]);
			assert.equal(context.editor.getText(), draft);
			assert.deepEqual(submitted, []);
			assert.deepEqual(context.pendingUserInputs, []);
		});
	}

	test("auto-runs only Enter-terminated command-like startup input and restores the unfinished draft", async () => {
		const draft = "/foo";
		const capture: EarlyInputCapture = {
			consume: () => ({ text: draft, submissions: ["/settings", "!pwd"] }),
		};
		const { context, submitted } = createStartupContext(draft, undefined);
		seedStartupInput(
			context.pendingUserInputs,
			context.editor,
			capture.consume(),
			context.startupReplayInputs,
			(text) => {
				context.startupDraftText = text;
			},
			(text) => {
				context.startupReplayActiveInput = text;
			},
		);

		await interactivePrototype.drainStartupReplayCommands.call(context);

		assert.deepEqual(submitted, ["/settings", "!pwd"]);
		assert.equal(context.editor.getText(), draft);
		assert.equal(context.startupReplayActiveInput, undefined);
		assert.deepEqual(context.startupReplayInputs, []);
		assert.deepEqual(context.pendingUserInputs, []);
	});
});

describe("startup input submission boundaries", () => {
	for (const draft of ["/", "!", "/model", "!cmd", "/model\nunfinished", "!cmd\nunfinished"]) {
		test(`keeps ${JSON.stringify(draft)} as an editor draft without early capture`, async () => {
			const { context, submitted } = createStartupContext(draft, undefined);
			const input = interactivePrototype.getUserInput.call(context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await interactivePrototype.drainStartupReplayCommands.call(context);
			assert.equal(context.editor.getText(), draft);
			assert.deepEqual(submitted, []);
			assert.deepEqual(context.pendingUserInputs, []);
			assert.ok(context.onInputCallback);
			context.onInputCallback({ text: "cleanup", draft: "cleanup" });
			await input;
		});
	}

	for (const { keys, submissions, draft } of [
		{ keys: "/model\r", submissions: ["/model"], draft: "" },
		{ keys: "/settings\r!pwd\r/model", submissions: ["/settings", "!pwd"], draft: "/model" },
	]) {
		test(`submits only captured Enter events in ${JSON.stringify(keys)}`, async () => {
			const captured: EarlyInputState = { text: "", submissions: [] };
			applyEarlyInputChunk(captured, keys);
			const { context, submitted } = createStartupContext("", { consume: () => captured });
			await interactivePrototype.drainStartupReplayCommands.call(context);
			assert.deepEqual(submitted, submissions);
			assert.equal(context.editor.getText(), draft);
			assert.deepEqual(context.pendingUserInputs, []);
		});
	}
});
