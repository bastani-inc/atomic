import { describe, expect, it, vi } from "vitest";
import { seedStartupInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	ui: { requestRender: () => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	handleBashCommand: (command: string, isExcluded: boolean) => Promise<void>;
	updateEditorBorderColor: () => void;
	isBashMode: boolean;
	renderDeferredUserInput: (text: string) => void;
	deliverStartupReplayPrompt: (text: string) => void;
	advanceStartupInputReplay: (text: string) => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
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
		handleBashCommand: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		isBashMode: false,
		flushPendingBashComponents: vi.fn(),
		renderDeferredUserInput: vi.fn(),
		deliverStartupReplayPrompt: InteractiveMode.prototype.deliverStartupReplayPrompt,
		advanceStartupInputReplay: InteractiveMode.prototype.advanceStartupInputReplay,
		pendingUserInputs: [],
		startupReplayInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("seeds captured startup input into the visible editor and prompt queue", () => {
		const pendingUserInputs: string[] = [];
		const editor = { setText: vi.fn() };

		seedStartupInput(pendingUserInputs, editor, {
			text: "draft before paint",
			submissions: ["submitted before paint"],
		});

		expect(editor.setText).toHaveBeenCalledWith("draft before paint");
		expect(pendingUserInputs).toEqual(["submitted before paint"]);
	});

	it("preserves command-like startup submissions as standalone editor replay", () => {
		const pendingUserInputs: string[] = [];
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

		expect(pendingUserInputs).toEqual(["ordinary prompt"]);
		expect(startupReplayInputs).toEqual(["!pwd"]);
		expect(startupDraftText).toBe("unfinished draft");
		expect(startupReplayActiveInput).toBe("/settings");
		expect(editor.setText).toHaveBeenCalledWith("/settings");
	});

	it("preserves startup submission order without merging later prompts into commands", () => {
		const pendingUserInputs: string[] = [];
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

		expect(pendingUserInputs).toEqual(["first prompt"]);
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

		expect(onInputCallback).toHaveBeenCalledWith("second prompt");
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.startupReplayInputs).toEqual([]);
		expect(context.editor.setText).not.toHaveBeenCalledWith("/settings\nsecond prompt");
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
		expect(onInputCallback).toHaveBeenCalledWith("explain result");
	});
});
