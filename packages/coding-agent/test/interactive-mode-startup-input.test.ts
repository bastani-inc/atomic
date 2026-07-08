import { describe, expect, it, vi } from "vitest";
import { seedStartupInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
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
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
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

	it("preserves command-like startup submissions as editor draft for normal routing", () => {
		const pendingUserInputs: string[] = [];
		const editor = { setText: vi.fn() };

		seedStartupInput(pendingUserInputs, editor, {
			text: "unfinished draft",
			submissions: ["ordinary prompt", "/settings", "!pwd"],
		});

		expect(pendingUserInputs).toEqual(["ordinary prompt"]);
		expect(editor.setText).toHaveBeenCalledWith("/settings\n!pwd\nunfinished draft");
	});

	it("preserves startup submission order after a command-like input", () => {
		const pendingUserInputs: string[] = [];
		const editor = { setText: vi.fn() };

		seedStartupInput(pendingUserInputs, editor, {
			text: "",
			submissions: ["first prompt", "/settings", "second prompt"],
		});

		expect(pendingUserInputs).toEqual(["first prompt"]);
		expect(editor.setText).toHaveBeenCalledWith("/settings\nsecond prompt");
	});
});
