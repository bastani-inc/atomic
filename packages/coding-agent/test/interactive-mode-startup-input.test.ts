import { describe, expect, it, vi } from "vitest";
import { seedStartupInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
	recoverCookedStartupInput: () => boolean;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	showSettingsSelector: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	startupReplayInputs: string[];
	startupReplayActiveInput?: string;
	startupDraftText?: string;
	options: { startupInputCapture?: { consume(): { text: string; submissions: string[] } } };
};
type InputContext = {
	defaultEditor?: { onSubmit?: (text: string) => void | Promise<void> };
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	startupReplayActiveInput?: string;
	drainStartupReplayCommands?: () => Promise<void>;
	recoverCookedStartupInput?: () => boolean;
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
			getText: vi.fn(() => ""),
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
		recoverCookedStartupInput: InteractiveMode.prototype.recoverCookedStartupInput,
		handleModelCommand: vi.fn(async () => {}),
		showSettingsSelector: vi.fn(),
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
		const order: string[] = [], context = createSubmitContext();
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

	it("advances startup replay when command-like input had leading whitespace", () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "/settings";
		context.startupReplayInputs = ["second prompt"];

		context.advanceStartupInputReplay("/settings");

		expect(context.pendingUserInputs).toEqual(["second prompt"]);
		expect(context.startupReplayActiveInput).toBeUndefined();
	});

	it("auto-submits captured command-like startup input before later prompts", async () => {
		const context = createSubmitContext();
		context.startupReplayActiveInput = "!pwd";
		context.startupReplayInputs = ["explain result"];
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("explain result");

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

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("later prompt");

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
		const pendingUserInputs: string[] = [];
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

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("first prompt");
		expect(context.handleBashCommand).not.toHaveBeenCalled();
		expect(context.startupReplayActiveInput).toBe("!pwd");

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("explain result");
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBeUndefined();
	});

	it("preserves raw-captured startup ordering across multiple commands and prompts", async () => {
		const pendingUserInputs: string[] = [];
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

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("explain result");

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBe("!date");
		expect(context.startupReplayInputs).toEqual(["explain date"]);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("explain date");

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

	it("recovers cooked immediate launch input as separate startup submissions", () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("!pwd\nordinary prompt after command\n/exit");

		context.recoverCookedStartupInput();

		expect(context.startupReplayActiveInput).toBe("!pwd");
		expect(context.startupReplayInputs).toEqual(["ordinary prompt after command", "/exit"]);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.editor.setText).toHaveBeenCalledWith("!pwd");
	});

	it("preserves cooked unfinished draft text after submitted startup input", () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("first submitted\nunfinished draft");

		context.recoverCookedStartupInput();

		expect(context.pendingUserInputs).toEqual(["first submitted"]);
		expect(context.startupReplayActiveInput).toBeUndefined();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.editor.setText).toHaveBeenCalledWith("unfinished draft");
	});

	it("replays cooked command-like input after submitted startup input", () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("first submitted\n/settings");

		context.recoverCookedStartupInput();

		expect(context.pendingUserInputs).toEqual(["first submitted"]);
		expect(context.startupReplayActiveInput).toBe("/settings");
		expect(context.editor.setText).toHaveBeenCalledWith("/settings");
	});

	it("preserves cooked draft text behind an active command-like submission", async () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("ordinary prompt after command\nunfinished draft");
		context.startupReplayActiveInput = "!pwd";
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("ordinary prompt after command");

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.editor.setText).toHaveBeenCalledWith("unfinished draft");
		expect(context.startupReplayActiveInput).toBeUndefined();
	});

	it("preserves cooked draft text after a command-like startup submission", () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("!pwd\nordinary prompt\nunfinished draft");

		context.recoverCookedStartupInput();

		expect(context.startupReplayActiveInput).toBe("!pwd");
		expect(context.startupReplayInputs).toEqual(["ordinary prompt"]);
		expect(context.startupDraftText).toBe("unfinished draft");
	});

	it("retries cooked startup recovery until editor text arrives", async () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce("")
			.mockReturnValueOnce("first submitted\nunfinished draft");

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("first submitted");

		expect(context.editor.getText).toHaveBeenCalledTimes(2);
		expect(context.editor.setText).toHaveBeenCalledWith("unfinished draft");
	});

	it("recovers a single cooked command-like startup submission", async () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("!pwd");
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		context.recoverCookedStartupInput();
		await context.drainStartupReplayCommands();

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.editor.setText).toHaveBeenCalledWith("!pwd");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.startupReplayActiveInput).toBeUndefined();
	});


	it("queues cooked submissions behind an active raw-captured command", async () => {
		const context = createSubmitContext();
		(context.editor.getText as ReturnType<typeof vi.fn>).mockReturnValue("ordinary prompt after command\n/exit");
		context.startupReplayActiveInput = "!pwd";
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("ordinary prompt after command");

		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.startupReplayActiveInput).toBe("/exit");
		expect(context.startupReplayInputs).toEqual([]);
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
