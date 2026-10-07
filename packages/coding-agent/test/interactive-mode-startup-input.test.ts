import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { applyEarlyInputChunk, type EarlyInputState } from "../src/main-early-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { seedStartupInput } from "../src/modes/interactive/interactive-mode-base.ts";
import type { InteractiveSubmission } from "../src/modes/interactive/interactive-submission.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
		getText: () => string;
	};
	ui: { requestRender: () => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	deferredStartupPending: boolean;
	deferredStartupPromise?: Promise<void>;
	flushPendingBashComponents: () => void;
	handleBashCommand: (command: string, isExcluded: boolean) => Promise<void>;
	ensureDeferredStartupComplete: () => Promise<void>;
	showStatus: (message: string) => void;
	updateEditorBorderColor: () => void;
	isBashMode: boolean;
	renderDeferredUserInput: (text: string) => void;
	deliverStartupReplayPrompt: (text: string) => void;
	advanceStartupInputReplay: (text: string) => void;
	drainStartupReplayCommands: () => Promise<void>;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	showSettingsSelector: () => void;
	onInputCallback?: (submission: InteractiveSubmission) => void;
	pendingUserInputs: InteractiveSubmission[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
	inputHandlerReadyRecorded: boolean;
	options: { startupInputCapture?: { consume(): { text: string; submissions: string[] } } };
};
type InputContext = {
	defaultEditor?: { onSubmit?: (text: string) => void | Promise<void> };
	onInputCallback?: (submission: InteractiveSubmission) => void;
	pendingUserInputs: InteractiveSubmission[];
	startupReplayActiveInput?: string;
	drainStartupReplayCommands?: () => Promise<void>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<InteractiveSubmission>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	let editorText = "";
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn((text: string) => {
				editorText = text;
			}),
			getText: vi.fn(() => editorText),
		},
		ui: {
			requestRender: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		options: {},
		inputHandlerReadyRecorded: true,
		deferredStartupPending: false,
		handleBashCommand: vi.fn(async () => {}),
		ensureDeferredStartupComplete: vi.fn(async () => {}),
		showStatus: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		isBashMode: false,
		flushPendingBashComponents: vi.fn(),
		renderDeferredUserInput: vi.fn(),
		deliverStartupReplayPrompt: InteractiveMode.prototype.deliverStartupReplayPrompt,
		advanceStartupInputReplay: InteractiveMode.prototype.advanceStartupInputReplay,
		drainStartupReplayCommands: InteractiveMode.prototype.drainStartupReplayCommands,
		handleModelCommand: vi.fn(async () => {}),
		showSettingsSelector: vi.fn(),
		pendingUserInputs: [],
		startupReplayInputs: [],
	};
	Object.setPrototypeOf(context, InteractiveMode.prototype);
	return context;
}

function seedCapturedKeys(context: SubmitContext, keys: string): void {
	const capture: EarlyInputState = { text: "", submissions: [] };
	applyEarlyInputChunk(capture, keys);
	seedStartupInput(
		context.pendingUserInputs,
		context.editor,
		capture,
		context.startupReplayInputs,
		(text) => {
			context.startupDraftText = text;
		},
		(text) => {
			context.startupReplayActiveInput = text;
		},
	);
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", draft: " early prompt " }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("loads deferred startup before model slash commands", async () => {
		const order: string[] = [];
		const context = createSubmitContext();
		context.ensureDeferredStartupComplete = vi.fn(async () => {
			order.push("deferred");
		});
		context.handleModelCommand = vi.fn(async (searchTerm?: string) => {
			order.push(`model:${searchTerm ?? ""}`);
		});
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/model gpt-5.5");

		expect(order).toEqual(["deferred", "model:gpt-5.5"]);
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("keeps local slash commands responsive without deferred startup", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/settings");

		expect(context.ensureDeferredStartupComplete).not.toHaveBeenCalled();
		expect(context.showSettingsSelector).toHaveBeenCalledTimes(1);
	});

	it("loads deferred startup before explicit extension slash submissions", async () => {
		const order: string[] = [],
			context = createSubmitContext();
		context.deferredStartupPending = true;
		context.ensureDeferredStartupComplete = vi.fn(async () => {
			order.push("deferred");
			context.deferredStartupPending = false;
		});
		context.session.prompt = vi.fn(async (text: string) => order.push(`prompt:${text}`));
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("/workflow list");
		expect(order).toEqual(["deferred", "prompt:/workflow list"]);
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("/workflow list");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt", draft: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "queued prompt",
			draft: "queued prompt",
		});
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("seeds captured startup input into the visible editor and prompt queue", () => {
		const pendingUserInputs: InteractiveSubmission[] = [];
		const editor = { setText: vi.fn() };

		seedStartupInput(pendingUserInputs, editor, {
			text: "draft before paint",
			submissions: ["submitted before paint"],
		});

		expect(editor.setText).toHaveBeenCalledWith("draft before paint");
		expect(pendingUserInputs).toEqual([{ text: "submitted before paint", draft: "submitted before paint" }]);
	});

	it("preserves command-like startup submissions as standalone editor replay", () => {
		const pendingUserInputs: InteractiveSubmission[] = [];
		const startupReplayInputs: string[] = [];
		let startupDraftText: string | undefined;
		let startupReplayActiveInput: string | undefined;
		const editor = { setText: vi.fn() };

		seedStartupInput(
			pendingUserInputs,
			editor,
			{
				text: "unfinished draft",
				submissions: ["ordinary prompt", "/settings", "!pwd"],
			},
			startupReplayInputs,
			(text) => {
				startupDraftText = text;
			},
			(text) => {
				startupReplayActiveInput = text;
			},
		);

		expect(pendingUserInputs).toEqual([{ text: "ordinary prompt", draft: "ordinary prompt" }]);
		expect(startupReplayInputs).toEqual(["!pwd"]);
		expect(startupDraftText).toBe("unfinished draft");
		expect(startupReplayActiveInput).toBe("/settings");
		expect(editor.setText).toHaveBeenCalledWith("/settings");
	});

	it("preserves startup submission order without merging later prompts into commands", () => {
		const pendingUserInputs: InteractiveSubmission[] = [];
		const startupReplayInputs: string[] = [];
		let startupReplayActiveInput: string | undefined;
		const editor = { setText: vi.fn() };

		seedStartupInput(
			pendingUserInputs,
			editor,
			{
				text: "",
				submissions: ["first prompt", "/settings", "second prompt"],
			},
			startupReplayInputs,
			undefined,
			(text) => {
				startupReplayActiveInput = text;
			},
		);

		expect(pendingUserInputs).toEqual([{ text: "first prompt", draft: "first prompt" }]);
		expect(startupReplayInputs).toEqual(["second prompt"]);
		expect(startupReplayActiveInput).toBe("/settings");
		expect(editor.setText).toHaveBeenCalledWith("/settings");
	});

	it("advances startup replay after a command-like submission is routed", () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "/settings";
		context.startupReplayInputs = ["second prompt"];
		const onInputCallback = vi.fn();
		context.onInputCallback = onInputCallback;

		context.advanceStartupInputReplay("/settings");

		expect(onInputCallback).toHaveBeenCalledWith({ text: "second prompt", draft: "second prompt" });
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.startupReplayInputs).toEqual([]);
		expect(context.editor.setText).not.toHaveBeenCalledWith("/settings\nsecond prompt");
	});

	it("advances startup replay when command-like input had leading whitespace", () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "/settings";
		context.startupReplayInputs = ["second prompt"];

		context.advanceStartupInputReplay("/settings");

		expect(context.pendingUserInputs).toEqual([{ text: "second prompt", draft: "second prompt" }]);
		expect(context.startupReplayActiveInput).toBeUndefined();
	});

	it("auto-submits captured command-like startup input before later prompts", async () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "!pwd";
		context.startupReplayInputs = ["explain result"];
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "explain result",
			draft: "explain result",
		});

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.startupReplayInputs).toEqual([]);
	});

	it("queues later prompts behind an active startup command before input callback install", async () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "!pwd";
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("later prompt");

		expect(context.pendingUserInputs).toEqual([]);
		expect(context.startupReplayInputs).toEqual(["later prompt"]);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "later prompt",
			draft: "later prompt",
		});

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.startupReplayInputs).toEqual([]);
	});

	it("queues streaming submissions behind an active startup command replay", async () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "!pwd";
		context.session.isStreaming = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("later prompt");

		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.startupReplayInputs).toEqual(["later prompt"]);
		expect(context.startupReplayActiveInput).toBe("!pwd");
		expect(context.editor.addToHistory).toHaveBeenCalledWith("later prompt");
	});

	it("returns prompts that originally preceded startup command replay first", async () => {
		const pendingUserInputs: InteractiveSubmission[] = [];
		const startupReplayInputs: string[] = [];
		let startupReplayActiveInput: string | undefined;
		const editor = { setText: vi.fn() };

		seedStartupInput(
			pendingUserInputs,
			editor,
			{
				text: "",
				submissions: ["first prompt", "!pwd", "explain result"],
			},
			startupReplayInputs,
			undefined,
			(text) => {
				startupReplayActiveInput = text;
			},
		);

		const context = createSubmitContext();
		context.pendingUserInputs = pendingUserInputs;
		context.startupReplayActiveInput = startupReplayActiveInput;
		context.startupReplayInputs = startupReplayInputs;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "first prompt",
			draft: "first prompt",
		});
		expect(context.handleBashCommand).not.toHaveBeenCalled();
		expect(context.startupReplayActiveInput).toBe("!pwd");

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "explain result",
			draft: "explain result",
		});
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBeUndefined();
	});

	it("preserves raw-captured startup ordering across multiple commands and prompts", async () => {
		const pendingUserInputs: InteractiveSubmission[] = [];
		const startupReplayInputs: string[] = [];
		let startupReplayActiveInput: string | undefined;
		const editor = { setText: vi.fn() };

		seedStartupInput(
			pendingUserInputs,
			editor,
			{
				text: "",
				submissions: ["!pwd", "explain result", "!date", "explain date"],
			},
			startupReplayInputs,
			undefined,
			(text) => {
				startupReplayActiveInput = text;
			},
		);

		expect(pendingUserInputs).toEqual([]);
		expect(startupReplayActiveInput).toBe("!pwd");
		expect(startupReplayInputs).toEqual(["explain result", "!date", "explain date"]);

		const context = createSubmitContext();
		context.startupReplayActiveInput = startupReplayActiveInput;
		context.startupReplayInputs = startupReplayInputs;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "explain result",
			draft: "explain result",
		});

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBe("!date");
		expect(context.startupReplayInputs).toEqual(["explain date"]);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "explain date",
			draft: "explain date",
		});

		expect(context.handleBashCommand).toHaveBeenCalledWith("date", false);
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.startupReplayInputs).toEqual([]);
	});

	it("keeps later startup commands standalone while replay advances", () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "/settings";
		context.startupReplayInputs = ["!pwd", "explain result"];

		context.advanceStartupInputReplay("/settings");

		expect(context.startupReplayActiveInput).toBe("!pwd");
		expect(context.startupReplayInputs).toEqual(["explain result"]);
		expect(context.editor.setText).toHaveBeenCalledWith("!pwd");
	});

	it("replays captured immediate launch input as separate startup submissions", () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "!pwd\rordinary prompt after command\r/exit\r");
		assert.equal(context.startupReplayActiveInput, "!pwd");
		assert.deepEqual(context.startupReplayInputs, ["ordinary prompt after command", "/exit"]);
		expect(context.editor.setText).toHaveBeenCalledWith("!pwd");
	});

	it("preserves captured unfinished draft text after submitted startup input", () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "first submitted\runfinished draft");
		assert.deepEqual(context.pendingUserInputs, [{ text: "first submitted", draft: "first submitted" }]);
		assert.equal(context.startupReplayActiveInput, undefined);
		expect(context.editor.setText).toHaveBeenCalledWith("unfinished draft");
	});

	it("replays captured command-like input after submitted startup input", () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "first submitted\r/settings\r");
		assert.deepEqual(context.pendingUserInputs, [{ text: "first submitted", draft: "first submitted" }]);
		assert.equal(context.startupReplayActiveInput, "/settings");
		expect(context.editor.setText).toHaveBeenCalledWith("/settings");
	});

	it("preserves captured draft text behind an active command-like submission", async () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "!pwd\rordinary prompt after command\runfinished draft");
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		assert.deepEqual(await interactiveModePrototype.getUserInput.call(context), {
			text: "ordinary prompt after command",
			draft: "ordinary prompt after command",
		});
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.editor.setText).toHaveBeenCalledWith("unfinished draft");
		assert.equal(context.startupReplayActiveInput, undefined);
	});

	it("preserves captured draft text after a command-like startup submission", () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "!pwd\rordinary prompt\runfinished draft");
		assert.equal(context.startupReplayActiveInput, "!pwd");
		assert.deepEqual(context.startupReplayInputs, ["ordinary prompt"]);
		assert.equal(context.startupDraftText, "unfinished draft");
	});

	it("does not submit multiline editor text without a captured Enter event", async () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("/model\nunfinished draft");
		const input = interactiveModePrototype.getUserInput.call(context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(context.editor.setText).not.toHaveBeenCalled();
		assert.deepEqual(context.pendingUserInputs, []);
		assert.equal(context.startupReplayActiveInput, undefined);
		assert.ok(context.onInputCallback);
		context.onInputCallback({ text: "cleanup", draft: "cleanup" });
		await input;
	});

	it("replays a single captured command-like startup submission", async () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "!pwd\r");
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.drainStartupReplayCommands();
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.editor.setText).toHaveBeenCalledWith("!pwd");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		assert.equal(context.startupReplayActiveInput, undefined);
	});

	it("queues captured submissions behind an active startup command", async () => {
		const context = createSubmitContext();
		seedCapturedKeys(context, "!pwd\rordinary prompt after command\r/exit\r");
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		assert.deepEqual(await interactiveModePrototype.getUserInput.call(context), {
			text: "ordinary prompt after command",
			draft: "ordinary prompt after command",
		});
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		assert.equal(context.startupReplayActiveInput, "/exit");
		assert.deepEqual(context.startupReplayInputs, []);
	});

	it("submits replayed bash commands separately from later normal prompts", async () => {
		const context = createSubmitContext();
		const onInputCallback = vi.fn();
		context.startupReplayActiveInput = "!pwd";
		context.startupReplayInputs = ["explain result"];
		context.onInputCallback = onInputCallback;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!pwd");

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.handleBashCommand).not.toHaveBeenCalledWith("pwd\nexplain result", false);
		expect(onInputCallback).toHaveBeenCalledWith({ text: "explain result", draft: "explain result" });
	});
});
